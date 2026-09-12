/**
 * Sprint #3 Phase C — 결제 실검증.
 *
 * 이전 상태: 웹훅 서명 검증 76줄이 전부였다. 결제를 '받을' 수단이 없었고,
 * 웹훅 멱등성도 없어 같은 이벤트가 두 번 오면 구독이 두 번 갱신됐다.
 *
 * Stripe 계정 없이 검증하기 위해 로컬 목 서버를 띄우고 STRIPE_API_BASE를 그쪽으로 돌린다.
 * 클라이언트를 스텁으로 바꾸지 않는 이유: form 인코딩·멱등성 헤더·재시도는
 * 실제 HTTP 요청이 나가야만 검증된다.
 */
import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Report } from "./report.js";
import { startStripeMock } from "./stripe-mock.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const WEBHOOK_SECRET = "whsec_verify_sprint3";
const report = new Report("Sprint#3 Phase C — 결제 (Checkout / 구독 / 웹훅 멱등성)");

const mock = await startStripeMock();

/**
 * 전용 API 인스턴스를 띄운다. 이미 도는 서버는 STRIPE_API_BASE가 진짜 Stripe라
 * 아웃바운드 검증을 할 수 없다. 포트도 분리해 기존 서버를 건드리지 않는다.
 */
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | undefined;

async function startApi(): Promise<void> {
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    // fileURLToPath를 써야 한다. URL.pathname은 퍼센트 인코딩된 문자열이라
    // 경로에 공백이나 비ASCII가 있으면 존재하지 않는 디렉터리가 되어 spawn ENOENT가 난다.
    cwd: fileURLToPath(new URL("../../api", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      STRIPE_SECRET_KEY: "sk_test_verify",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: mock.url,
      BILLING_SUCCESS_URL: "https://app.example.test/billing/success",
      BILLING_CANCEL_URL: "https://app.example.test/billing/cancel",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`api did not start on ${PORT}:\n${logs.join("").slice(-2000)}`);
}

async function api<T = unknown>(method: string, path: string, body?: unknown, key = process.env.AIOS_API_KEY!) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed as T };
}

/** Stripe와 동일한 방식으로 웹훅 서명을 만든다 */
function signWebhook(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postWebhook(event: unknown) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${BASE}/v1/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signWebhook(payload) },
    body: payload,
  });
  const text = await res.text();
  let body: { outcome?: string; raw?: string };
  try { body = JSON.parse(text) as { outcome?: string }; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let orgId = "";
try {
  await startApi();

  const me = await api<{ orgId: string }>("GET", "/v1/me");
  orgId = me.body.orgId;
  // 검증은 상태 독립적이어야 한다. 이전 실행이 남긴 stripe_customer_id가 있으면
  // '고객 생성' 경로가 실행되지 않아 아웃바운드 호출 수 검사가 거짓 FAIL을 낸다.
  // 그래서 매번 Checkout 이전 상태(free, 고객 없음)로 초기화한다.
  await db.query(
    `insert into subscriptions (org_id, plan_id) values ($1,'free')
     on conflict (org_id) do update
       set plan_id = 'free', status = 'active',
           stripe_customer_id = null, stripe_subscription_id = null,
           cancel_at_period_end = false`,
    [orgId],
  );

  report.section("C.1 플랜 및 구독 조회");

  await report.guard("플랜 목록", async () => {
    const r = await api<{ plans: { id: string }[] }>("GET", "/v1/billing/plans");
    report.check("플랜 존재", r.status === 200 && (r.body.plans?.length ?? 0) > 0,
      `count=${r.body.plans?.length ?? 0}`);
  });

  await report.guard("현재 구독 + 사용량", async () => {
    const r = await api<{ subscription: { plan_id: string }; usage: { tokens: number } }>(
      "GET", "/v1/billing/subscription",
    );
    report.check("구독 조회 200", r.status === 200, `status=${r.status}`);
    report.check("플랜 ID 존재", !!r.body.subscription?.plan_id, `plan=${r.body.subscription?.plan_id}`);
    report.check("사용량 필드 존재", typeof r.body.usage?.tokens === "number", JSON.stringify(r.body.usage));
  });

  report.section("C.2 Checkout 세션 생성 (실제 아웃바운드 HTTP)");

  await report.guard("Checkout URL이 발급된다", async () => {
    const before = mock.requests.length;
    const r = await api<{ checkoutUrl: string; sessionId: string }>(
      "POST", "/v1/billing/checkout", { priceId: "price_pro_monthly" },
    );
    report.check("200 + URL", r.status === 200 && !!r.body.checkoutUrl,
      `status=${r.status} url=${r.body.checkoutUrl}`);

    const sent = mock.requests.slice(before);
    report.check("Stripe로 실제 요청이 나갔다", sent.length >= 2,
      sent.map((s) => s.path).join(" -> "));
    const checkout = sent.find((s) => s.path.startsWith("/v1/checkout/sessions"));
    report.check("form 인코딩이 Stripe 표기를 따른다",
      !!checkout && checkout.body.includes("line_items%5B0%5D%5Bprice%5D=price_pro_monthly"),
      checkout?.body.slice(0, 200) ?? "요청 없음");
    report.check("mode=subscription", !!checkout?.body.includes("mode=subscription"), "");
    report.check("멱등성 키가 붙는다", !!checkout?.idempotencyKey, `key=${checkout?.idempotencyKey?.slice(0,12)}`);
    report.check("Authorization 헤더 전달", checkout?.authorization === "Bearer sk_test_verify", "");
  });

  await report.guard("고객은 재사용된다 (유령 고객 방지)", async () => {
    const before = mock.requests.filter((r) => r.path.startsWith("/v1/customers")).length;
    await api("POST", "/v1/billing/checkout", { priceId: "price_team_monthly" });
    const after = mock.requests.filter((r) => r.path.startsWith("/v1/customers")).length;
    report.check("고객 생성 호출이 늘지 않음", after === before, `before=${before} after=${after}`);
  });

  await report.guard("중복 클릭은 같은 멱등성 키를 쓴다", async () => {
    const before = mock.requests.filter((r) => r.path.startsWith("/v1/checkout")).length;
    const [a, b] = await Promise.all([
      api<{ sessionId: string }>("POST", "/v1/billing/checkout", { priceId: "price_dup" }),
      api<{ sessionId: string }>("POST", "/v1/billing/checkout", { priceId: "price_dup" }),
    ]);
    const sent = mock.requests.filter((r) => r.path.startsWith("/v1/checkout")).slice(before);
    const keys = new Set(sent.map((s) => s.idempotencyKey));
    report.check("두 요청의 멱등성 키가 동일", keys.size === 1, `distinct keys=${keys.size}`);
    report.check("Stripe가 같은 세션을 반환", a.body.sessionId === b.body.sessionId,
      `${a.body.sessionId} vs ${b.body.sessionId}`);
  });

  report.section("C.3 일시적 5xx 재시도");

  await report.guard("500 두 번 후 성공한다", async () => {
    mock.failNext(2);
    const before = mock.requests.length;
    const r = await api<{ portalUrl: string }>("POST", "/v1/billing/portal", {});
    const attempts = mock.requests.length - before;
    report.check("최종 성공", r.status === 200 && !!r.body.portalUrl, `status=${r.status}`);
    report.check("3회 시도 (초기 1 + 재시도 2)", attempts === 3, `attempts=${attempts}`);
  });

  await report.guard("4xx는 재시도하지 않는다", async () => {
    const before = mock.requests.length;
    // 목이 모르는 경로 → 404. 클라이언트는 재시도하지 않아야 한다.
    const r = await api("POST", "/v1/billing/cancel", {});
    const attempts = mock.requests.length - before;
    report.check("재시도 없음 (0 또는 1회)", attempts <= 1, `attempts=${attempts} status=${r.status}`);
  });

  report.section("C.4 웹훅 — 서명");

  await report.guard("서명 없는 웹훅은 거부", async () => {
    const res = await fetch(`${BASE}/v1/billing/webhook`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    report.check("서명 누락 거부", res.status >= 400, `status=${res.status}`);
  });

  await report.guard("변조된 서명은 거부", async () => {
    const payload = JSON.stringify({ id: "evt_bad", type: "ping", data: { object: {} } });
    const res = await fetch(`${BASE}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now()/1000)},v1=${"0".repeat(64)}` },
      body: payload,
    });
    report.check("서명 불일치 거부 (401)", res.status === 401, `status=${res.status}`);
  });

  await report.guard("오래된 타임스탬프는 거부 (리플레이 방어)", async () => {
    const payload = JSON.stringify({ id: "evt_old", type: "ping", data: { object: {} } });
    const t = Math.floor(Date.now() / 1000) - 3600;
    const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
    const res = await fetch(`${BASE}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      body: payload,
    });
    report.check("타임스탬프 초과 거부", res.status === 401, `status=${res.status}`);
  });

  report.section("C.5 웹훅 — 구독 라이프사이클");

  const customerId = `cus_verify_${randomUUID().slice(0, 8)}`;

  await report.guard("checkout.session.completed가 고객을 조직에 연결한다", async () => {
    const evt = {
      id: `evt_checkout_${randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", customer: customerId, subscription: "sub_verify_1", client_reference_id: orgId } },
    };
    const r = await postWebhook(evt);
    report.check("200 applied", r.status === 200 && r.body.outcome === "applied", `outcome=${r.body.outcome}`);
    const { rows } = await db.query<{ stripe_customer_id: string }>(
      "select stripe_customer_id from subscriptions where org_id = $1", [orgId],
    );
    report.check("customer_id 저장됨", rows[0]?.stripe_customer_id === customerId,
      `db=${rows[0]?.stripe_customer_id}`);
  });

  await report.guard("동일 이벤트 재전송은 중복으로 무시된다 (멱등성)", async () => {
    const evt = {
      id: `evt_dup_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_verify_1", customer: customerId, status: "active",
                        current_period_end: Math.floor(Date.now()/1000) + 86400,
                        items: { data: [{ price: { lookup_key: "pro" } }] } } },
    };
    const first = await postWebhook(evt);
    const second = await postWebhook(evt);
    report.check("1회차 applied", first.body.outcome === "applied", `outcome=${first.body.outcome}`);
    report.check("2회차 duplicate", second.body.outcome === "duplicate", `outcome=${second.body.outcome}`);
    const { rows } = await db.query<{ count: string }>(
      "select count(*) from stripe_events where id = $1", [evt.id],
    );
    report.check("이벤트 기록은 1건", rows[0]?.count === "1", `count=${rows[0]?.count}`);
  });

  await report.guard("플랜이 갱신된다", async () => {
    const { rows } = await db.query<{ plan_id: string; status: string }>(
      "select plan_id, status from subscriptions where org_id = $1", [orgId],
    );
    report.check("plan_id=pro", rows[0]?.plan_id === "pro", `plan=${rows[0]?.plan_id}`);
    report.check("status=active", rows[0]?.status === "active", `status=${rows[0]?.status}`);
  });

  await report.guard("알 수 없는 lookup_key는 플랜을 바꾸지 않는다", async () => {
    const evt = {
      id: `evt_unknown_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_verify_1", customer: customerId, status: "active",
                        items: { data: [{ price: { lookup_key: "totally-unknown-price" } }] } } },
    };
    await postWebhook(evt);
    const { rows } = await db.query<{ plan_id: string }>(
      "select plan_id from subscriptions where org_id = $1", [orgId],
    );
    // 이전 코드는 알 수 없는 가격을 'pro'로 승격시켰다. 지금은 기존 플랜을 유지해야 한다.
    report.check("플랜 유지 (임의 승격 없음)", rows[0]?.plan_id === "pro", `plan=${rows[0]?.plan_id}`);
  });

  await report.guard("결제 실패는 past_due로만 표시 (즉시 강등 없음)", async () => {
    const evt = {
      id: `evt_failed_${randomUUID()}`,
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", customer: customerId, attempt_count: 1 } },
    };
    const r = await postWebhook(evt);
    const { rows } = await db.query<{ status: string; plan_id: string }>(
      "select status, plan_id from subscriptions where org_id = $1", [orgId],
    );
    report.check("applied", r.body.outcome === "applied", `outcome=${r.body.outcome}`);
    report.check("status=past_due", rows[0]?.status === "past_due", `status=${rows[0]?.status}`);
    report.check("플랜은 유지 (free로 강등 안 함)", rows[0]?.plan_id === "pro", `plan=${rows[0]?.plan_id}`);
  });

  await report.guard("결제 성공 시 복구된다", async () => {
    const evt = {
      id: `evt_ok_${randomUUID()}`,
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_2", customer: customerId } },
    };
    await postWebhook(evt);
    const { rows } = await db.query<{ status: string }>(
      "select status from subscriptions where org_id = $1", [orgId],
    );
    report.check("status=active 복귀", rows[0]?.status === "active", `status=${rows[0]?.status}`);
  });

  await report.guard("구독 삭제는 free로 강등", async () => {
    const evt = {
      id: `evt_del_${randomUUID()}`,
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_verify_1", customer: customerId } },
    };
    const r = await postWebhook(evt);
    const { rows } = await db.query<{ plan_id: string; status: string }>(
      "select plan_id, status from subscriptions where org_id = $1", [orgId],
    );
    report.check("applied", r.body.outcome === "applied", `outcome=${r.body.outcome}`);
    report.check("plan=free", rows[0]?.plan_id === "free", `plan=${rows[0]?.plan_id}`);
    report.check("status=canceled", rows[0]?.status === "canceled", `status=${rows[0]?.status}`);
  });

  await report.guard("매칭 실패는 unmatched로 보고된다 (조용한 유실 방지)", async () => {
    const evt = {
      id: `evt_orphan_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_x", customer: "cus_does_not_exist", status: "active" } },
    };
    const r = await postWebhook(evt);
    report.check("200 + unmatched", r.status === 200 && r.body.outcome === "unmatched",
      `status=${r.status} outcome=${r.body.outcome}`);
  });

  report.section("C.6 권한");

  await report.guard("member 역할은 Checkout을 만들 수 없다", async () => {
    const { createHash } = await import("node:crypto");
    const raw = `aios_live_member_${randomUUID().slice(0, 8)}`;
    await db.query(
      `insert into api_keys (org_id, name, key_hash, key_prefix, scopes, role)
       values ($1,'member-key',$2,$3,'{*}','member')`,
      [orgId, createHash("sha256").update(raw).digest("hex"), raw.slice(0, 14)],
    );
    const r = await api("POST", "/v1/billing/checkout", { priceId: "price_pro_monthly" }, raw);
    report.check("403 Forbidden", r.status === 403, `status=${r.status}`);
  });
} finally {
  child?.kill("SIGTERM");
  await mock.close();
  await db.end();
}

report.finish();
