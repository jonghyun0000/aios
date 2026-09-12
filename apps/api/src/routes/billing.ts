import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { requireRole } from "../auth.js";
import { StripeClient } from "../billing/client.js";
import { handleStripeEvent, verifyStripeSignature, type StripeEvent } from "../billing/stripe.js";

/**
 * 결제 라우트.
 *
 * 이전 상태: 웹훅 서명 검증만 있었다. 즉 "결제를 받을 수는 없고, 남이 결제했다는 소식만
 * 들을 수 있는" 상태였다. 실제로 유료 전환을 하려면 Checkout 세션 생성이 필요하다.
 *
 * 왜 Stripe Checkout(호스팅)인가:
 *  카드번호가 우리 서버를 지나가지 않으면 PCI-DSS 범위가 SAQ-A로 줄어든다.
 *  자체 결제폼을 만들면 절감되는 것은 리다이렉트 한 번이고, 늘어나는 것은 감사 범위 전체다.
 */

function stripeClient(ctx: AppContext): StripeClient {
  if (!ctx.env.STRIPE_SECRET_KEY) throw new ValidationError("billing is not configured (STRIPE_SECRET_KEY missing)");
  return new StripeClient({ secretKey: ctx.env.STRIPE_SECRET_KEY, baseUrl: ctx.env.STRIPE_API_BASE });
}

/**
 * 멱등성 키를 결정적으로 만든다.
 * 랜덤 UUID를 쓰면 사용자가 결제 버튼을 두 번 눌렀을 때 세션이 두 개 생긴다.
 * (조직, 작업, 가격, 시간 버킷)으로 해시하면 짧은 시간 내 중복 클릭이 하나로 합쳐진다.
 */
function idempotencyKey(parts: (string | number)[], bucketSeconds = 60): string {
  const bucket = Math.floor(Date.now() / 1000 / bucketSeconds);
  return createHash("sha256").update([...parts, bucket].join("|")).digest("hex").slice(0, 48);
}

export function registerBillingRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------- 플랜 목록 ----------
  app.get("/v1/billing/plans", async () => {
    const { rows } = await ctx.pool.query(
      "select id, name, monthly_price_cents, included_tokens, limits from plans order by monthly_price_cents",
    );
    return { plans: rows };
  });

  // ---------- 현재 구독 + 사용량 ----------
  app.get("/v1/billing/subscription", async (req) => {
    const { rows } = await ctx.pool.query(
      `select s.plan_id, s.status, s.current_period_end, s.cancel_at_period_end,
              s.stripe_customer_id is not null as has_payment_method,
              p.name as plan_name, p.monthly_price_cents, p.included_tokens, p.limits
         from subscriptions s join plans p on p.id = s.plan_id
        where s.org_id = $1`,
      [req.auth.orgId],
    );
    // 로컬 실행에는 Stripe 구독이 없다. 첫 화면의 정상 상태를 404로 표현하지 않는다.
    if (req.auth.via === "local") rows[0] = {
      plan_id: "local", status: "active", current_period_end: null, cancel_at_period_end: false,
      has_payment_method: false, plan_name: "로컬 · 외부 API 요금 없음", monthly_price_cents: 0, included_tokens: 0, limits: {},
    };
    if (!rows[0]) throw new NotFoundError("no subscription for this organization");

    // 현재 청구 주기의 사용량. 주기 시작을 모르면 30일로 근사한다.
    // 컬럼은 usage_events의 실제 스키마(input_tokens/output_tokens/cost_usd)를 쓴다.
    const { rows: usage } = await ctx.pool.query<{ tokens: string; cost_usd: string }>(
      `select coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens,
              coalesce(sum(cost_usd), 0) as cost_usd
         from usage_events
        where org_id = $1
          and created_at >= coalesce($2::timestamptz - interval '1 month', now() - interval '30 days')`,
      [req.auth.orgId, rows[0].current_period_end ?? null],
    );

    const included = Number(rows[0].included_tokens);
    const used = Number(usage[0]?.tokens ?? 0);
    return {
      subscription: rows[0],
      usage: {
        tokens: used,
        includedTokens: included,
        // 무제한(0)일 때 0으로 나누지 않는다
        percentUsed: included > 0 ? Math.round((used / included) * 1000) / 10 : null,
        // 센트로 반올림해 노출한다 — 프론트가 통화 포맷을 하기 쉽고,
        // 소수점 6자리 원본은 내부 정산용이다.
        costCents: Math.round(Number(usage[0]?.cost_usd ?? 0) * 100),
      },
    };
  });

  // ---------- Checkout 세션 ----------
  app.post("/v1/billing/checkout", async (req) => {
    requireRole(req.auth, "owner"); // 조직에 요금을 발생시키는 행위
    const body = z
      .object({
        priceId: z.string().min(1),
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      })
      .parse(req.body);

    const successUrl = body.successUrl ?? ctx.env.BILLING_SUCCESS_URL;
    const cancelUrl = body.cancelUrl ?? ctx.env.BILLING_CANCEL_URL;
    if (!successUrl || !cancelUrl) {
      throw new ValidationError("successUrl/cancelUrl required (or set BILLING_SUCCESS_URL/BILLING_CANCEL_URL)");
    }

    const stripe = stripeClient(ctx);
    const customerId = await ensureCustomer(ctx, stripe, req.auth.orgId);

    const session = await stripe.createCheckoutSession(
      { customerId, priceId: body.priceId, successUrl, cancelUrl, orgId: req.auth.orgId },
      idempotencyKey(["checkout", req.auth.orgId, body.priceId]),
    );
    return { checkoutUrl: session.url, sessionId: session.id };
  });

  // ---------- 고객 포털 ----------
  app.post("/v1/billing/portal", async (req) => {
    requireRole(req.auth, "owner");
    const body = z.object({ returnUrl: z.string().url().optional() }).parse(req.body ?? {});
    const returnUrl = body.returnUrl ?? ctx.env.BILLING_SUCCESS_URL ?? ctx.env.PUBLIC_BASE_URL;

    const { rows } = await ctx.pool.query<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from subscriptions where org_id = $1",
      [req.auth.orgId],
    );
    if (!rows[0]?.stripe_customer_id) {
      throw new ValidationError("no Stripe customer for this organization; complete a checkout first");
    }
    const stripe = stripeClient(ctx);
    const portal = await stripe.createBillingPortalSession(
      { customerId: rows[0].stripe_customer_id, returnUrl },
      idempotencyKey(["portal", req.auth.orgId]),
    );
    return { portalUrl: portal.url };
  });

  // ---------- 해지 ----------
  app.post("/v1/billing/cancel", async (req) => {
    requireRole(req.auth, "owner");
    const body = z.object({ immediately: z.boolean().default(false) }).parse(req.body ?? {});
    const { rows } = await ctx.pool.query<{ stripe_subscription_id: string | null }>(
      "select stripe_subscription_id from subscriptions where org_id = $1",
      [req.auth.orgId],
    );
    if (!rows[0]?.stripe_subscription_id) throw new NotFoundError("no active Stripe subscription");

    const stripe = stripeClient(ctx);
    // 기본은 기간 만료 시 해지 — 이미 낸 돈만큼은 쓸 수 있어야 한다.
    const result = await stripe.cancelSubscription(
      rows[0].stripe_subscription_id,
      !body.immediately,
      idempotencyKey(["cancel", req.auth.orgId, String(body.immediately)]),
    );
    // 낙관적 반영. 확정은 웹훅이 한다 — Stripe가 진실의 원천이다.
    await ctx.pool.query(
      "update subscriptions set cancel_at_period_end = $2, updated_at = now() where org_id = $1",
      [req.auth.orgId, result.cancel_at_period_end],
    );
    return { canceled: true, cancelAtPeriodEnd: result.cancel_at_period_end };
  });

  // ---------- 웹훅 (공개 경로, 서명이 곧 인증) ----------
  app.post("/v1/billing/webhook", async (req, reply) => {
    const secret = ctx.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ValidationError("billing not configured");
    const signature = req.headers["stripe-signature"];
    const rawBody = (req as { rawBody?: string }).rawBody;
    if (typeof signature !== "string" || !rawBody) throw new ValidationError("missing signature");
    verifyStripeSignature(rawBody, signature, secret);

    const event = JSON.parse(rawBody) as StripeEvent;
    const outcome = await handleStripeEvent(ctx.pool, event);

    // unmatched는 "서명은 맞는데 우리 DB에서 조직을 못 찾았다" = 조사가 필요한 상태.
    // 200으로 삼키되 반드시 로그에 남긴다. 이걸 놓치면 "결제는 됐는데 플랜이 안 올라감"이
    // 고객 문의로만 발견된다.
    if (outcome === "unmatched") {
      req.log.error({ eventId: event.id, type: event.type }, "stripe webhook matched no organization");
    } else {
      req.log.info({ eventId: event.id, type: event.type, outcome }, "stripe webhook");
    }
    return reply.status(200).send({ received: true, outcome });
  });
}

/**
 * 조직에 Stripe 고객을 보장한다.
 * 이미 있으면 재사용 — 매번 만들면 Stripe 대시보드가 유령 고객으로 채워지고,
 * 어느 고객이 진짜 구독을 가졌는지 알 수 없게 된다.
 */
async function ensureCustomer(ctx: AppContext, stripe: StripeClient, orgId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ stripe_customer_id: string | null }>(
    "select stripe_customer_id from subscriptions where org_id = $1",
    [orgId],
  );
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;

  const { rows: org } = await ctx.pool.query<{ name: string; email: string | null }>(
    `select o.name, (select u.email from org_members m join users u on u.id = m.user_id
                      where m.org_id = o.id and m.role = 'owner' order by m.created_at limit 1) as email
       from organizations o where o.id = $1`,
    [orgId],
  );
  if (!org[0]) throw new NotFoundError("organization not found");

  const customer = await stripe.createCustomer(
    { orgId, name: org[0].name, email: org[0].email ?? undefined },
    idempotencyKey(["customer", orgId], 86_400), // 하루 버킷 — 고객은 하나면 족하다
  );

  // 구독 행이 없으면 free로 만든다. 있으면 고객 ID만 붙인다.
  await ctx.pool.query(
    `insert into subscriptions (org_id, plan_id, stripe_customer_id)
     values ($1, 'free', $2)
     on conflict (org_id) do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now()`,
    [orgId, customer.id],
  );
  return customer.id;
}

/** 라우트 밖에서도 쓰는 유틸 (테스트/CLI) */
export { idempotencyKey as __idempotencyKey, randomUUID as __randomUUID };
