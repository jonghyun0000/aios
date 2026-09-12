import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import type { FastifyRequest } from "fastify";
import { AuthError, ForbiddenError } from "@aios/shared";
import type { AuthContext } from "@aios/shared";
import type { AppContext } from "./context.js";
import { verifySessionToken } from "./oauth/flow.js";

/**
 * 인증: 두 갈래.
 *  - 사람(웹/VSCode): Supabase OAuth → JWT(HS256) → 우리는 검증만
 *  - 기계(CLI/SDK/CI): API 키 "aios_live_*" → sha256 해시 조회 (평문은 DB에 없다)
 * 인가: org_members.role 기반 RBAC — 라우트에서 requireRole로 강제.
 */

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<AuthContext> {
  const header = req.headers.authorization;
  // 브라우저는 Authorization 헤더 대신 HttpOnly 쿠키를 보낸다 — 그쪽도 받는다.
  const cookieToken = (req as { cookies?: Record<string, string | undefined> }).cookies?.aios_session;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : cookieToken;

  // 로컬 무인증 모드. 토큰이 있으면 그것을 우선한다 — 켜 두더라도 키/세션 경로가
  // 그대로 동작해야 이 플래그가 다른 인증을 조용히 무력화하지 않는다.
  if (!token && ctx.env.LOCAL_NO_AUTH && isLoopback(req) && isLocalBrowserRequest(req)) return authenticateLocal(ctx);

  if (!token) throw new AuthError("missing bearer token");

  // 접두사로 분기한다. 토큰 종류를 순서대로 시도하면 실패 경로마다 DB를 때리게 되고,
  // 어느 인증이 왜 실패했는지도 알 수 없어진다.
  if (token.startsWith("aios_sess_")) return authenticateSession(ctx, req, token);
  if (token.startsWith("aios_")) return authenticateApiKey(ctx, token);
  return authenticateJwt(ctx, req, token);
}

/**
 * 자체 OAuth 세션 토큰. DB에는 sha256만 저장돼 있으므로 해시로 조회한다.
 * 조직 선택 로직은 JWT 경로와 동일해야 한다 — 두 인증 수단이 서로 다른 조직을
 * 고르면 같은 사용자가 로그인 방법에 따라 다른 데이터를 보게 된다.
 */
async function authenticateSession(ctx: AppContext, req: FastifyRequest, token: string): Promise<AuthContext> {
  const session = await verifySessionToken(ctx.pool, token);
  if (!session) throw new AuthError("session is invalid or expired");
  const membership = await resolveMembership(ctx, req, session.userId);
  return { orgId: membership.org_id, userId: session.userId, role: membership.role, scopes: ["*"], via: "session" };
}

/** 조직 선택: 헤더 x-org-id, 없으면 첫 멤버십 (1인 org가 대다수) */
async function resolveMembership(
  ctx: AppContext,
  req: FastifyRequest,
  userId: string,
): Promise<{ org_id: string; role: AuthContext["role"] }> {
  const requestedOrg = req.headers["x-org-id"] as string | undefined;
  const { rows } = await ctx.pool.query<{ org_id: string; role: AuthContext["role"] }>(
    requestedOrg
      ? "select org_id, role from org_members where user_id = $1 and org_id = $2"
      : "select org_id, role from org_members where user_id = $1 order by created_at limit 1",
    requestedOrg ? [userId, requestedOrg] : [userId],
  );
  const membership = rows[0];
  if (!membership) throw new ForbiddenError("no organization membership");
  return membership;
}

/**
 * 요청이 이 기계 자신에게서 왔는가.
 *
 * req.ip가 아니라 소켓 주소를 직접 본다: req.ip는 trustProxy가 켜지는 순간
 * X-Forwarded-For를 신뢰하게 되고, 그러면 외부에서 헤더 한 줄로 무인증을 얻는다.
 * 소켓 주소는 위조할 수 없다.
 */
export function isLoopback(req: FastifyRequest): boolean {
  const addr = req.socket?.remoteAddress;
  if (!addr) return false;
  // IPv4-mapped IPv6(::ffff:127.0.0.1) 형태로도 온다.
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return v4 === "127.0.0.1" || v4.startsWith("127.") || addr === "::1";
}

/** 루프백 연결도 외부 웹사이트에서 만들 수 있으므로 Host/Origin을 함께 확인한다. */
export function isLocalBrowserRequest(req: FastifyRequest): boolean {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const base = new URL(`http://${host}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    return !req.headers.origin || req.headers.origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * 무인증 요청이 사용할 조직. 매 요청 DB를 때리지 않도록 프로세스당 1회만 해결한다.
 * 조직이 없으면 만든다 — 시드를 돌리지 않은 새 DB에서도 바로 쓸 수 있어야
 * "키 없이 바로 쓴다"는 목적이 성립한다.
 */
let localOrgId: Promise<string> | null = null;
export function resetLocalOrgCache(): void {
  localOrgId = null;
}

async function authenticateLocal(ctx: AppContext): Promise<AuthContext> {
  localOrgId ??= ctx.pool
    .query<{ id: string }>(
      `insert into organizations (name, slug) values ($1, $2)
       on conflict (slug) do update set name = organizations.name
       returning id`,
      ["Local", ctx.env.LOCAL_NO_AUTH_ORG_SLUG],
    )
    .then((r) => r.rows[0]!.id)
    .catch((err: Error) => {
      localOrgId = null; // 실패를 캐시하면 DB가 살아난 뒤에도 영원히 막힌다
      throw err;
    });
  return { orgId: await localOrgId, role: "owner", scopes: ["*"], via: "local" };
}

async function authenticateApiKey(ctx: AppContext, token: string): Promise<AuthContext> {
  const hash = createHash("sha256").update(token).digest("hex");
  const { rows } = await ctx.pool.query<{
    org_id: string; scopes: string[]; id: string; expires_at: Date | null; role: AuthContext["role"];
  }>(
    "select id, org_id, scopes, expires_at, role from api_keys where key_hash = $1",
    [hash],
  );
  const key = rows[0];
  if (!key) throw new AuthError("invalid api key");
  if (key.expires_at && key.expires_at < new Date()) throw new AuthError("api key expired");

  // last_used_at 갱신은 응답 경로에서 기다리지 않는다
  void ctx.pool.query("update api_keys set last_used_at = now() where id = $1", [key.id]).catch(() => {});

  // role은 키에 저장된 값을 쓴다. 'member' 하드코딩은 CLI/CI가 관리 작업을
  // 영원히 못 하게 만들었다(마켓플레이스 설치·게시·결제 전부 403).
  return { orgId: key.org_id, role: key.role, scopes: key.scopes, via: "api_key" };
}

async function authenticateJwt(ctx: AppContext, req: FastifyRequest, token: string): Promise<AuthContext> {
  if (!ctx.env.SUPABASE_JWT_SECRET) throw new AuthError("jwt auth not configured");
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(ctx.env.SUPABASE_JWT_SECRET));
    userId = String(payload.sub);
  } catch {
    throw new AuthError("invalid jwt");
  }

  const membership = await resolveMembership(ctx, req, userId);
  return { orgId: membership.org_id, userId, role: membership.role, scopes: ["*"], via: "jwt" };
}

export function requireRole(auth: AuthContext, minimum: keyof typeof ROLE_RANK): void {
  if (ROLE_RANK[auth.role] < ROLE_RANK[minimum]) {
    throw new ForbiddenError(`requires role ${minimum}`);
  }
}
