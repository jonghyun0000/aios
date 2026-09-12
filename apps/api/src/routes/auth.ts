import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AuthError, ValidationError, NotFoundError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { PROVIDERS } from "../oauth/providers.js";
import {
  startFlow, consumeState, exchangeCode, completeLogin, revokeSession, isAllowedRedirect,
} from "../oauth/flow.js";

/**
 * OAuth 로그인 라우트.
 *
 * 경로 설계:
 *   GET  /v1/auth/providers          — 어떤 로그인이 설정돼 있는지 (프론트가 버튼을 그릴 근거)
 *   GET  /v1/auth/:provider/start    — authorize URL 발급 (302 또는 JSON)
 *   GET  /v1/auth/:provider/callback — IdP가 되돌아오는 곳
 *   POST /v1/auth/logout             — 세션 폐기
 *   GET  /v1/auth/session            — 현재 세션 확인
 *
 * 이 라우트들은 전역 인증 훅에서 제외된다 — 로그인하려면 인증 없이 접근할 수 있어야 한다.
 */

const PROVIDER_PARAM = z.object({ provider: z.enum(["github", "google"]) });

interface ProviderCreds { clientId: string; clientSecret: string }

function credsFor(ctx: AppContext, name: string): ProviderCreds {
  const map: Record<string, [string | undefined, string | undefined]> = {
    github: [ctx.env.GITHUB_OAUTH_CLIENT_ID, ctx.env.GITHUB_OAUTH_CLIENT_SECRET],
    google: [ctx.env.GOOGLE_OAUTH_CLIENT_ID, ctx.env.GOOGLE_OAUTH_CLIENT_SECRET],
  };
  const [clientId, clientSecret] = map[name] ?? [];
  if (!clientId || !clientSecret) {
    throw new ValidationError(`oauth provider '${name}' is not configured on this server`);
  }
  return { clientId, clientSecret };
}

const redirectUriFor = (ctx: AppContext, name: string) =>
  `${ctx.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/auth/${name}/callback`;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/auth/providers", async () => {
    // 설정된 것만 노출한다. 미설정 프로바이더 버튼을 그려두면 사용자가 500을 만난다.
    const configured = Object.keys(PROVIDERS).filter((name) => {
      try { credsFor(ctx, name); return true; } catch { return false; }
    });
    return { providers: configured, sessionTtlDays: ctx.env.AUTH_SESSION_TTL_DAYS };
  });

  app.get("/v1/auth/:provider/start", async (req, reply) => {
    const { provider: name } = PROVIDER_PARAM.parse(req.params);
    const q = z.object({
      redirect_to: z.string().url().optional(),
      // 브라우저는 302를 원하고, CLI/확장은 URL 문자열을 원한다.
      mode: z.enum(["redirect", "json"]).default("redirect"),
    }).parse(req.query ?? {});

    const provider = PROVIDERS[name]!;
    const { clientId } = credsFor(ctx, name);
    const { authorizeUrl, state } = await startFlow(ctx.pool, provider, {
      clientId,
      redirectUri: redirectUriFor(ctx, name),
      redirectTo: q.redirect_to,
      allowList: ctx.env.OAUTH_ALLOWED_REDIRECTS,
    });

    if (q.mode === "json") return { authorizeUrl, state };
    return reply.redirect(authorizeUrl, 302);
  });

  app.get("/v1/auth/:provider/callback", async (req, reply) => {
    const { provider: name } = PROVIDER_PARAM.parse(req.params);
    const q = z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(req.query ?? {});

    // 사용자가 IdP 동의 화면에서 취소한 경우 — 500이 아니라 이유를 담아 되돌린다.
    if (q.error) throw new AuthError(`oauth denied: ${q.error_description ?? q.error}`);
    if (!q.code || !q.state) throw new ValidationError("code and state are required");

    const consumed = await consumeState(ctx.pool, q.state);
    if (consumed.provider !== name) {
      // state를 다른 프로바이더 콜백에 재사용하는 시도.
      throw new AuthError("state does not match this provider");
    }

    const provider = PROVIDERS[name]!;
    const { clientId, clientSecret } = credsFor(ctx, name);
    const accessToken = await exchangeCode(provider, {
      code: q.code,
      clientId,
      clientSecret,
      redirectUri: redirectUriFor(ctx, name),
      codeVerifier: consumed.codeVerifier,
    });

    const profile = await provider.fetchProfile(accessToken);
    const result = await completeLogin(ctx.pool, name, profile, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
      ttlDays: ctx.env.AUTH_SESSION_TTL_DAYS,
    });

    await ctx.pool.query(
      `insert into audit_logs (org_id, actor_id, action, target, metadata)
       values ($1,$2,'auth.login',$3,$4)`,
      [result.orgId, result.userId, name, JSON.stringify({ isNewUser: result.isNewUser })],
    ).catch(() => undefined); // 감사 로그 실패로 로그인을 막지는 않는다

    // 세션 쿠키: HttpOnly로 JS 접근 차단(XSS로 토큰 탈취 불가),
    // SameSite=Lax로 CSRF 완화, production에서만 Secure(로컬 http 개발을 막지 않기 위해).
    reply.setCookie?.("aios_session", result.token.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.env.NODE_ENV === "production",
      path: "/",
      expires: result.token.expiresAt,
    });

    if (consumed.redirectTo && isAllowedRedirect(consumed.redirectTo, ctx.env.OAUTH_ALLOWED_REDIRECTS)) {
      // 토큰을 URL에 싣지 않는다 — 브라우저 히스토리·리퍼러·서버 로그에 남는다.
      // 쿠키로 이미 전달했으므로 리다이렉트는 목적지만 알려주면 된다.
      return reply.redirect(consumed.redirectTo, 302);
    }
    return {
      token: result.token.token,
      expiresAt: result.token.expiresAt.toISOString(),
      userId: result.userId,
      orgId: result.orgId,
      isNewUser: result.isNewUser,
    };
  });

  app.get("/v1/auth/session", async (req) => {
    const token = bearerOrCookie(req);
    if (!token) throw new AuthError("no session token");
    const { rows } = await ctx.pool.query(
      `select u.id as user_id, u.email, u.display_name, u.avatar_url,
              s.expires_at,
              (select json_agg(json_build_object('orgId', m.org_id, 'role', m.role, 'name', o.name))
                 from org_members m join organizations o on o.id = m.org_id
                where m.user_id = u.id) as organizations
         from auth_sessions s join users u on u.id = s.user_id
        where s.token_hash = encode(sha256($1::bytea), 'hex')
          and s.revoked_at is null and s.expires_at > now()`,
      [token],
    );
    if (!rows[0]) throw new AuthError("session is invalid or expired");
    return { session: rows[0] };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = bearerOrCookie(req);
    if (!token) throw new AuthError("no session token");
    const revoked = await revokeSession(ctx.pool, token);
    reply.clearCookie?.("aios_session", { path: "/" });
    if (!revoked) throw new NotFoundError("session already revoked or unknown");
    return { loggedOut: true };
  });
}

/** 브라우저는 쿠키, CLI는 Authorization 헤더 — 둘 다 받는다. */
function bearerOrCookie(req: {
  headers: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
}): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.aios_session ?? null;
}
