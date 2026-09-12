import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { AuthError, ValidationError, ProviderError } from "@aios/shared";
import type { OAuthProvider, OAuthProfile } from "./providers.js";

/**
 * Authorization Code Flow (+ PKCE).
 *
 * 세 가지 공격을 각각 다른 수단으로 막는다:
 *  1) CSRF (공격자가 자기 계정을 피해자 브라우저에 로그인시킴)
 *     → state. 서버가 발급하고 DB에 저장, 콜백에서 일치·미사용·미만료 확인 후 즉시 소비.
 *  2) code 가로채기 (리다이렉트 URL이 새는 환경)
 *     → PKCE. code_verifier를 서버만 알고, 교환 시 함께 보낸다.
 *  3) open redirect (로그인 후 공격자 사이트로 튕김)
 *     → redirect_to 화이트리스트. 클라이언트가 준 URL을 그대로 믿지 않는다.
 *
 * state를 Redis가 아니라 Postgres에 두는 이유: 로그인은 초당 수천 건이 아니고,
 * 실패 시 원인 추적(어느 state가 언제 발급됐는지)이 가능해야 한다.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // 10분. 사람이 로그인 화면을 넘기기에 충분하고, 방치된 state는 죽는다.

export interface StartResult {
  authorizeUrl: string;
  state: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43자 — RFC 7636 권장 범위(43~128)
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** 화이트리스트 검증. 오리진 단위로 비교한다 — 경로까지 고정하면 SPA 라우팅을 못 쓴다. */
export function isAllowedRedirect(redirectTo: string, allowList: string): boolean {
  const allowed = allowList.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return false; // 미설정 = 아무 데도 못 보낸다 (안전한 기본값)
  let target: URL;
  try {
    target = new URL(redirectTo);
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    try {
      const base = new URL(entry);
      // 오리진 완전 일치. startsWith 비교는 evil-example.com이 example.com을 통과시킨다.
      return base.origin === target.origin;
    } catch {
      return false;
    }
  });
}

export async function startFlow(
  pool: Pool,
  provider: OAuthProvider,
  opts: { clientId: string; redirectUri: string; redirectTo?: string; allowList: string },
): Promise<StartResult> {
  if (opts.redirectTo && !isAllowedRedirect(opts.redirectTo, opts.allowList)) {
    throw new ValidationError(`redirect_to origin is not in OAUTH_ALLOWED_REDIRECTS`);
  }

  const state = base64url(randomBytes(24));
  const { verifier, challenge } = createPkcePair();

  await pool.query(
    `insert into oauth_states (state, provider, code_verifier, redirect_to, expires_at)
     values ($1,$2,$3,$4, now() + interval '10 minutes')`,
    [state, provider.name, verifier, opts.redirectTo ?? null],
  );

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  if (provider.supportsPkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { authorizeUrl: url.toString(), state };
}

export interface ConsumedState {
  provider: string;
  codeVerifier: string;
  redirectTo: string | null;
}

/**
 * state를 소비한다(1회용). delete ... returning으로 조회와 삭제를 원자적으로 처리 —
 * select 후 delete로 나누면 동시 요청 두 개가 같은 state를 통과할 수 있다.
 */
export async function consumeState(pool: Pool, state: string): Promise<ConsumedState> {
  const { rows } = await pool.query<{ provider: string; code_verifier: string; redirect_to: string | null; expired: boolean }>(
    `delete from oauth_states where state = $1
     returning provider, code_verifier, redirect_to, (expires_at < now()) as expired`,
    [state],
  );
  const row = rows[0];
  if (!row) throw new AuthError("invalid or already-used oauth state");
  if (row.expired) throw new AuthError("oauth state expired; restart the login");
  return { provider: row.provider, codeVerifier: row.code_verifier, redirectTo: row.redirect_to };
}

export async function exchangeCode(
  provider: OAuthProvider,
  opts: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });
  if (provider.supportsPkce) body.set("code_verifier", opts.codeVerifier);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError("oauth", `token exchange failed (${res.status}): ${text.slice(0, 200)}`, { status: res.status });
    }
    const parsed = JSON.parse(text) as { access_token?: string; error?: string; error_description?: string };
    if (!parsed.access_token) {
      // GitHub은 실패해도 HTTP 200에 error 필드를 담아 보낸다 — 상태 코드만 보면 놓친다.
      throw new ProviderError("oauth", parsed.error_description ?? parsed.error ?? "no access_token in response", { status: 400 });
    }
    return parsed.access_token;
  } finally {
    clearTimeout(timer);
  }
}

export interface SessionToken {
  token: string;
  expiresAt: Date;
}

/**
 * 로그인 확정: 프로필 → user upsert → oauth_accounts 연결 → 세션 토큰 발급.
 *
 * 계정 연결 규칙(중요): provider_account_id로 먼저 찾고, 없으면 email로 찾는다.
 * email로 찾아 연결하는 것은 프로바이더가 이메일을 '검증했다'고 보증할 때만 안전하다.
 * 그래서 providers.ts가 미검증 이메일을 거부한다 — 여기서의 email 매칭이
 * 계정 탈취 경로가 되지 않도록 하는 것이 그 코드의 존재 이유다.
 */
export async function completeLogin(
  pool: Pool,
  providerName: string,
  profile: OAuthProfile,
  meta: { userAgent?: string; ip?: string; ttlDays: number },
): Promise<{ token: SessionToken; userId: string; orgId: string | null; isNewUser: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const { rows: linked } = await client.query<{ user_id: string }>(
      "select user_id from oauth_accounts where provider = $1 and provider_account_id = $2",
      [providerName, profile.id],
    );

    let userId: string;
    let isNewUser = false;

    if (linked[0]) {
      userId = linked[0].user_id;
      await client.query(
        "update oauth_accounts set last_login_at = now(), email = $3 where provider = $1 and provider_account_id = $2",
        [providerName, profile.id, profile.email],
      );
    } else {
      const { rows: byEmail } = await client.query<{ id: string }>(
        "select id from users where lower(email) = lower($1)",
        [profile.email],
      );
      if (byEmail[0]) {
        userId = byEmail[0].id;
      } else {
        const { rows: created } = await client.query<{ id: string }>(
          `insert into users (id, email, display_name, avatar_url)
           values (gen_random_uuid(), $1, $2, $3) returning id`,
          [profile.email, profile.name ?? profile.email.split("@")[0], profile.avatarUrl ?? null],
        );
        userId = created[0]!.id;
        isNewUser = true;
      }
      await client.query(
        `insert into oauth_accounts (user_id, provider, provider_account_id, email)
         values ($1,$2,$3,$4)
         on conflict (provider, provider_account_id) do update set last_login_at = now()`,
        [userId, providerName, profile.id, profile.email],
      );
    }

    // 신규 사용자는 자기 조직을 갖는다. 조직 없이 로그인하면 어떤 리소스도 만들 수 없어
    // 로그인이 성공해도 앱이 아무것도 못 하는 상태가 된다.
    let orgId: string | null = null;
    const { rows: membership } = await client.query<{ org_id: string }>(
      "select org_id from org_members where user_id = $1 order by created_at limit 1",
      [userId],
    );
    if (membership[0]) {
      orgId = membership[0].org_id;
    } else {
      const slugBase = profile.email.split("@")[0]!.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 30);
      const { rows: org } = await client.query<{ id: string }>(
        `insert into organizations (name, slug) values ($1, $2) returning id`,
        [profile.name ?? slugBase, `${slugBase}-${randomBytes(3).toString("hex")}`],
      );
      orgId = org[0]!.id;
      await client.query(
        "insert into org_members (org_id, user_id, role) values ($1,$2,'owner')",
        [orgId, userId],
      );
      await client.query(
        "insert into subscriptions (org_id, plan_id) values ($1,'free') on conflict (org_id) do nothing",
        [orgId],
      );
    }

    // 토큰 원문은 반환만 하고 저장하지 않는다. DB에는 sha256만 — 유출돼도 세션을 못 훔친다.
    const raw = `aios_sess_${base64url(randomBytes(32))}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    const expiresAt = new Date(Date.now() + meta.ttlDays * 24 * 3600 * 1000);
    await client.query(
      `insert into auth_sessions (user_id, token_hash, user_agent, ip, expires_at)
       values ($1,$2,$3,$4::inet,$5)`,
      [userId, hash, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, expiresAt],
    );

    await client.query("commit");
    return { token: { token: raw, expiresAt }, userId, orgId, isNewUser };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** 세션 토큰 검증. 인증 경로에서 호출된다. */
export async function verifySessionToken(
  pool: Pool,
  raw: string,
): Promise<{ userId: string } | null> {
  const hash = createHash("sha256").update(raw).digest("hex");
  const { rows } = await pool.query<{ user_id: string; token_hash: string }>(
    `select user_id, token_hash from auth_sessions
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // 해시 조회는 이미 상수시간이 아니지만(인덱스 조회), 비교 자체는 상수시간으로 둔다.
  const a = Buffer.from(row.token_hash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId: row.user_id };
}

export async function revokeSession(pool: Pool, raw: string): Promise<boolean> {
  const hash = createHash("sha256").update(raw).digest("hex");
  const { rowCount } = await pool.query(
    "update auth_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null",
    [hash],
  );
  return (rowCount ?? 0) > 0;
}

/** 만료된 state/세션 청소. 워커가 주기적으로 부른다 — 안 하면 테이블이 무한히 자란다. */
export async function pruneExpired(pool: Pool): Promise<{ states: number; sessions: number }> {
  const s = await pool.query("delete from oauth_states where expires_at < now() - interval '1 hour'");
  const t = await pool.query("delete from auth_sessions where expires_at < now() - interval '30 days'");
  return { states: s.rowCount ?? 0, sessions: t.rowCount ?? 0 };
}

export { STATE_TTL_MS };
