/**
 * Sprint #3 Phase D — OAuth 로그인 실검증.
 *
 * 이전 상태: apps/api/src에 'oauth' 문자열이 0회 등장했다. Supabase JWT 검증만 있었고,
 * Supabase를 쓰지 않는 배포에는 로그인 수단 자체가 없었다.
 *
 * 실제 GitHub/Google 없이 검증하기 위해 IdP 목을 띄우고 프로바이더 URL을 그쪽으로 돌린다.
 * flow 로직(state 1회성, PKCE, open redirect 차단, 세션 발급)은 순수 함수 + DB이므로
 * 목 IdP만 있으면 전 경로를 진짜로 실행할 수 있다.
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { Report } from "./report.js";
import {
  startFlow, consumeState, exchangeCode, completeLogin,
  verifySessionToken, revokeSession, isAllowedRedirect, createPkcePair, pruneExpired,
} from "../../api/src/oauth/flow.js";
import type { OAuthProvider } from "../../api/src/oauth/providers.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const report = new Report("Sprint#3 Phase D — OAuth 로그인 (자체 authorization code flow)");

// ---------- IdP 목 ----------
interface IdpMock { url: string; close(): Promise<void>; lastTokenBody: string | null }

async function startIdp(): Promise<IdpMock> {
  const state: IdpMock = { url: "", lastTokenBody: null, close: async () => {} };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.startsWith("/token")) {
        state.lastTokenBody = body;
        const params = new URLSearchParams(body);
        if (params.get("code") === "BAD_CODE") {
          // GitHub은 실패해도 200 + error 필드로 응답한다 — 그 동작을 재현한다.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_verification_code", error_description: "The code is incorrect" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock_access_token", token_type: "bearer" }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

const idp = await startIdp();
const uniq = randomUUID().slice(0, 8);

const mockProvider: OAuthProvider = {
  name: "mockidp",
  scopes: ["email", "profile"],
  authorizeUrl: `${idp.url}/authorize`,
  tokenUrl: `${idp.url}/token`,
  supportsPkce: true,
  fetchProfile: async (token) => {
    if (token !== "mock_access_token") throw new Error("bad token");
    return { id: `idp-user-${uniq}`, email: `oauth-${uniq}@example.test`, name: "OAuth Tester" };
  },
};

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const ALLOW = "https://app.example.test,http://localhost:5173";

try {
  report.section("D.1 PKCE");

  await report.guard("code_verifier/challenge가 RFC 7636을 만족한다", async () => {
    const { verifier, challenge } = createPkcePair();
    report.check("verifier 길이 43~128", verifier.length >= 43 && verifier.length <= 128, `len=${verifier.length}`);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    report.check("challenge = base64url(sha256(verifier))", challenge === expected, `${challenge.slice(0,16)}...`);
    report.check("두 번 호출하면 다른 값", createPkcePair().verifier !== verifier, "");
  });

  report.section("D.2 open redirect 차단");

  await report.guard("화이트리스트 판정", async () => {
    report.check("허용된 오리진 통과", isAllowedRedirect("https://app.example.test/dashboard", ALLOW), "");
    report.check("다른 오리진 차단", !isAllowedRedirect("https://evil.test/steal", ALLOW), "");
    // startsWith 비교였다면 통과해 버리는 고전적 우회.
    report.check("접두사 우회 차단 (evil-app.example.test.evil.test)",
      !isAllowedRedirect("https://app.example.test.evil.test/x", ALLOW), "");
    report.check("스킴 다운그레이드 차단", !isAllowedRedirect("http://app.example.test/x", ALLOW), "");
    report.check("화이트리스트 미설정 시 전부 차단", !isAllowedRedirect("https://app.example.test/x", ""), "");
    report.check("URL이 아니면 차단", !isAllowedRedirect("javascript:alert(1)", ALLOW), "");
  });

  await report.guard("허용되지 않은 redirect_to로는 flow를 시작할 수 없다", async () => {
    let threw = false;
    try {
      await startFlow(pool, mockProvider, {
        clientId: "cid", redirectUri: "http://localhost:8787/cb",
        redirectTo: "https://evil.test/x", allowList: ALLOW,
      });
    } catch { threw = true; }
    report.check("거부됨", threw, "");
  });

  report.section("D.3 authorize URL");

  let state1 = "";
  await report.guard("authorize URL에 필수 파라미터가 모두 들어간다", async () => {
    const r = await startFlow(pool, mockProvider, {
      clientId: "test-client-id", redirectUri: "http://localhost:8787/v1/auth/mockidp/callback",
      redirectTo: "https://app.example.test/done", allowList: ALLOW,
    });
    state1 = r.state;
    const u = new URL(r.authorizeUrl);
    report.check("client_id", u.searchParams.get("client_id") === "test-client-id", "");
    report.check("response_type=code", u.searchParams.get("response_type") === "code", "");
    report.check("scope", u.searchParams.get("scope") === "email profile", "");
    report.check("state 존재", !!u.searchParams.get("state"), "");
    report.check("PKCE challenge (S256)",
      u.searchParams.get("code_challenge_method") === "S256" && !!u.searchParams.get("code_challenge"), "");
    const { rows } = await pool.query("select 1 from oauth_states where state = $1", [r.state]);
    report.check("state가 DB에 저장됨", rows.length === 1, "");
  });

  report.section("D.4 state 소비 (CSRF 방어)");

  await report.guard("state는 정확히 한 번만 쓸 수 있다", async () => {
    const consumed = await consumeState(pool, state1);
    report.check("1회차 성공", consumed.provider === "mockidp", `provider=${consumed.provider}`);
    report.check("redirect_to 보존", consumed.redirectTo === "https://app.example.test/done", `${consumed.redirectTo}`);
    let threw = false;
    try { await consumeState(pool, state1); } catch { threw = true; }
    report.check("2회차 거부 (재사용 불가)", threw, "");
  });

  await report.guard("알 수 없는 state는 거부", async () => {
    let threw = false;
    try { await consumeState(pool, "state-that-never-existed"); } catch { threw = true; }
    report.check("거부됨", threw, "");
  });

  await report.guard("만료된 state는 거부", async () => {
    const expired = `expired-${uniq}`;
    await pool.query(
      `insert into oauth_states (state, provider, code_verifier, expires_at)
       values ($1,'mockidp','v', now() - interval '1 minute')`,
      [expired],
    );
    let threw = false;
    try { await consumeState(pool, expired); } catch { threw = true; }
    report.check("만료 거부", threw, "");
    const { rows } = await pool.query("select 1 from oauth_states where state = $1", [expired]);
    report.check("만료된 state도 소비되어 삭제됨", rows.length === 0, "");
  });

  await report.guard("동시 요청 중 하나만 state를 소비한다", async () => {
    const r = await startFlow(pool, mockProvider, {
      clientId: "cid", redirectUri: "http://x/cb", allowList: ALLOW,
    });
    const results = await Promise.allSettled([consumeState(pool, r.state), consumeState(pool, r.state)]);
    const ok = results.filter((x) => x.status === "fulfilled").length;
    report.check("정확히 1회 성공", ok === 1, `fulfilled=${ok}`);
  });

  report.section("D.5 code 교환");

  await report.guard("PKCE verifier가 토큰 요청에 포함된다", async () => {
    const token = await exchangeCode(mockProvider, {
      code: "GOOD_CODE", clientId: "cid", clientSecret: "secret",
      redirectUri: "http://x/cb", codeVerifier: "the-verifier-value",
    });
    report.check("access_token 수신", token === "mock_access_token", `token=${token}`);
    const body = new URLSearchParams(idp.lastTokenBody ?? "");
    report.check("code_verifier 전송됨", body.get("code_verifier") === "the-verifier-value", "");
    report.check("grant_type=authorization_code", body.get("grant_type") === "authorization_code", "");
    report.check("client_secret 전송됨", body.get("client_secret") === "secret", "");
  });

  await report.guard("HTTP 200 안의 error도 실패로 처리된다", async () => {
    // GitHub의 실제 동작. 상태 코드만 보면 성공으로 오인한다.
    let threw = false;
    let msg = "";
    try {
      await exchangeCode(mockProvider, {
        code: "BAD_CODE", clientId: "cid", clientSecret: "s",
        redirectUri: "http://x/cb", codeVerifier: "v",
      });
    } catch (err) { threw = true; msg = err instanceof Error ? err.message : String(err); }
    report.check("200+error를 실패로 인식", threw, msg.slice(0, 120));
  });

  report.section("D.6 로그인 확정");

  let sessionToken = "";
  let userId = "";
  let orgId = "";

  await report.guard("신규 사용자 → user + org + 구독 + 세션이 만들어진다", async () => {
    const profile = await mockProvider.fetchProfile("mock_access_token");
    const r = await completeLogin(pool, "mockidp", profile, { ttlDays: 30, userAgent: "verify", ip: "127.0.0.1" });
    sessionToken = r.token.token;
    userId = r.userId;
    orgId = r.orgId!;
    report.check("신규 사용자로 판정", r.isNewUser, `isNewUser=${r.isNewUser}`);
    report.check("조직이 생성됨", !!r.orgId, `orgId=${r.orgId}`);
    report.check("세션 토큰 접두사", sessionToken.startsWith("aios_sess_"), sessionToken.slice(0, 16));

    const { rows: member } = await pool.query<{ role: string }>(
      "select role from org_members where user_id = $1 and org_id = $2", [userId, orgId],
    );
    report.check("owner 역할 부여", member[0]?.role === "owner", `role=${member[0]?.role}`);
    const { rows: sub } = await pool.query("select 1 from subscriptions where org_id = $1", [orgId]);
    report.check("free 구독 생성", sub.length === 1, "");
  });

  await report.guard("세션 토큰 원문은 DB에 저장되지 않는다", async () => {
    const { rows } = await pool.query<{ token_hash: string }>(
      "select token_hash from auth_sessions where user_id = $1", [userId],
    );
    const hash = createHash("sha256").update(sessionToken).digest("hex");
    report.check("sha256만 저장", rows[0]?.token_hash === hash, `stored=${rows[0]?.token_hash?.slice(0,16)}...`);
    const { rows: raw } = await pool.query(
      "select 1 from auth_sessions where token_hash = $1", [sessionToken],
    );
    report.check("원문으로는 조회되지 않음", raw.length === 0, "");
  });

  await report.guard("재로그인은 기존 사용자·조직을 재사용한다", async () => {
    const profile = await mockProvider.fetchProfile("mock_access_token");
    const r = await completeLogin(pool, "mockidp", profile, { ttlDays: 30 });
    report.check("신규 아님", !r.isNewUser, `isNewUser=${r.isNewUser}`);
    report.check("같은 user", r.userId === userId, `${r.userId} vs ${userId}`);
    report.check("같은 org", r.orgId === orgId, `${r.orgId} vs ${orgId}`);
    report.check("새 세션 토큰 발급", r.token.token !== sessionToken, "");
  });

  await report.guard("다른 프로바이더의 같은 이메일은 같은 계정에 연결된다", async () => {
    const r = await completeLogin(pool, "otheridp",
      { id: `other-${uniq}`, email: `oauth-${uniq}@example.test`, name: "Same Person" },
      { ttlDays: 30 });
    report.check("동일 user로 연결", r.userId === userId, `${r.userId} vs ${userId}`);
    const { rows } = await pool.query<{ count: string }>(
      "select count(*) from oauth_accounts where user_id = $1", [userId],
    );
    report.check("oauth_accounts 2건", rows[0]?.count === "2", `count=${rows[0]?.count}`);
  });

  report.section("D.7 세션 검증 및 폐기");

  await report.guard("유효한 세션 토큰이 검증된다", async () => {
    const v = await verifySessionToken(pool, sessionToken);
    report.check("검증 성공", v?.userId === userId, `userId=${v?.userId}`);
  });

  await report.guard("조작된 토큰은 거부", async () => {
    const v = await verifySessionToken(pool, sessionToken.slice(0, -4) + "AAAA");
    report.check("거부됨", v === null, "");
  });

  await report.guard("폐기된 세션은 즉시 무효화된다", async () => {
    const revoked = await revokeSession(pool, sessionToken);
    report.check("폐기 성공", revoked, "");
    report.check("이후 검증 실패", (await verifySessionToken(pool, sessionToken)) === null, "");
    report.check("중복 폐기는 false", !(await revokeSession(pool, sessionToken)), "");
  });

  await report.guard("만료된 세션은 검증되지 않는다", async () => {
    const profile = { id: `exp-${uniq}`, email: `exp-${uniq}@example.test` };
    const r = await completeLogin(pool, "mockidp", profile, { ttlDays: 1 });
    await pool.query(
      "update auth_sessions set expires_at = now() - interval '1 hour' where token_hash = $1",
      [createHash("sha256").update(r.token.token).digest("hex")],
    );
    report.check("만료 거부", (await verifySessionToken(pool, r.token.token)) === null, "");
  });

  report.section("D.8 정리 작업");

  await report.guard("만료된 state/세션이 청소된다", async () => {
    await pool.query(
      `insert into oauth_states (state, provider, code_verifier, expires_at)
       values ($1,'mockidp','v', now() - interval '2 hours')`,
      [`stale-${uniq}`],
    );
    const pruned = await pruneExpired(pool);
    report.check("state 청소됨", pruned.states >= 1, `states=${pruned.states}`);
    const { rows } = await pool.query("select 1 from oauth_states where state = $1", [`stale-${uniq}`]);
    report.check("실제로 삭제됨", rows.length === 0, "");
  });
} finally {
  await pool.end();
  await idp.close();
}

report.finish();
