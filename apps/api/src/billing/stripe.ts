import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthError } from "@aios/shared";
import type { Pool } from "pg";

/**
 * Stripe 웹훅 처리.
 *
 * Stripe SDK 없이 서명을 직접 검증하는 이유: 필요한 것은 웹훅 검증과 몇 개의 이벤트 분기뿐이고,
 * 서명 스킴(HMAC-SHA256 of "t.payload")은 공개 스펙이다. SDK 전체를 들이면
 * 의존성·콜드스타트 비용 대비 얻는 게 없다. (Checkout 세션 생성 등 아웃바운드 호출이
 * 필요해지는 시점에 SDK 도입을 재평가한다.)
 */

export function verifyStripeSignature(payload: string, header: string, secret: string, toleranceSec = 300): void {
  const parts = new Map(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) throw new AuthError("malformed stripe signature");

  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) {
    throw new AuthError("stripe signature timestamp out of tolerance"); // 리플레이 방어
  }

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("invalid stripe signature");
  }
}

/**
 * 필요한 필드만 좁게 선언한다. Stripe 페이로드 전체를 타이핑하지 않는 이유:
 * 우리가 읽는 필드만 계약이고, 나머지를 타입으로 고정하면 Stripe가 필드를 추가할 때마다
 * 우리 타입이 거짓말이 된다.
 */
export interface StripeSubscriptionObject {
  id?: string;
  customer?: string;
  status?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: { data?: { price?: { lookup_key?: string; id?: string } }[] };
}

export interface StripeCheckoutSessionObject {
  id?: string;
  customer?: string;
  subscription?: string;
  client_reference_id?: string;
  metadata?: Record<string, string>;
}

export interface StripeInvoiceObject {
  id?: string;
  customer?: string;
  subscription?: string;
  amount_paid?: number;
  attempt_count?: number;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeSubscriptionObject & StripeCheckoutSessionObject & StripeInvoiceObject };
}

export type StripeEventOutcome = "applied" | "duplicate" | "ignored" | "unmatched";

/**
 * 웹훅 이벤트 처리.
 *
 * 이전 구현의 세 가지 결함을 고친다:
 *  1) 멱등성 없음 — Stripe는 at-least-once 전달이라 같은 이벤트가 두 번 온다.
 *     stripe_events에 event.id를 먼저 insert하고, 충돌하면 조용히 종료한다.
 *  2) checkout.session.completed 미처리 — 결제가 끝나도 stripe_customer_id가
 *     구독 행에 연결되지 않아 이후 모든 subscription.* 이벤트가 매칭에 실패했다.
 *  3) 매칭 실패를 감지하지 못함 — update가 0행을 갱신해도 200을 반환해
 *     결제는 됐는데 플랜은 안 올라가는 상황이 조용히 발생했다. 이제 결과를 반환한다.
 *
 * 반환값을 두는 이유: 라우트가 로그·메트릭에 남길 수 있어야 "웹훅은 200인데
 * 아무 일도 안 일어남"을 사후에 찾을 수 있다.
 */
export async function handleStripeEvent(pool: Pool, event: StripeEvent): Promise<StripeEventOutcome> {
  // 멱등성 게이트. 트랜잭션 밖에서 먼저 잡는다 — 중복이면 아래 작업 자체를 하지 않는다.
  const claim = await pool.query(
    `insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing`,
    [event.id, event.type],
  );
  if (claim.rowCount === 0) return "duplicate";

  try {
    return await applyStripeEvent(pool, event);
  } catch (err) {
    // 처리에 실패했으면 멱등성 기록을 되돌린다. 그렇지 않으면 Stripe의 재전송이
    // "중복"으로 무시되어 이벤트가 영원히 유실된다.
    await pool.query("delete from stripe_events where id = $1", [event.id]).catch(() => undefined);
    throw err;
  }
}

async function applyStripeEvent(pool: Pool, event: StripeEvent): Promise<StripeEventOutcome> {
  switch (event.type) {
    // 결제 완료 — 이 시점에 고객 ID를 조직에 확정 연결한다.
    case "checkout.session.completed": {
      const s = event.data.object;
      const orgId = s.client_reference_id ?? s.metadata?.org_id;
      if (!orgId || !s.customer) return "unmatched";
      const { rowCount } = await pool.query(
        `update subscriptions
            set stripe_customer_id = $2, stripe_subscription_id = coalesce($3, stripe_subscription_id),
                status = 'active', updated_at = now()
          where org_id = $1`,
        [orgId, s.customer, s.subscription ?? null],
      );
      return rowCount === 0 ? "unmatched" : "applied";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      // lookup_key를 우리 plans.id와 맞춰 쓴다. 없으면 기존 플랜을 유지한다 —
      // 'pro'로 기본값을 넣던 이전 코드는 알 수 없는 가격을 유료 플랜으로 승격시켰다.
      const planId = sub.items?.data?.[0]?.price?.lookup_key ?? null;
      const orgId = sub.metadata?.org_id ?? null;
      const { rowCount } = await pool.query(
        `update subscriptions
            set plan_id = coalesce(
                  (select id from plans where id = $2), plan_id),
                status = $3,
                stripe_subscription_id = $4,
                cancel_at_period_end = coalesce($6, cancel_at_period_end),
                current_period_end = case when $5::bigint is null then current_period_end
                                          else to_timestamp($5::bigint) end,
                updated_at = now()
          where stripe_customer_id = $1 or ($7::uuid is not null and org_id = $7::uuid)`,
        [sub.customer, planId, sub.status, sub.id, sub.current_period_end ?? null,
         sub.cancel_at_period_end ?? null, orgId],
      );
      return rowCount === 0 ? "unmatched" : "applied";
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const { rowCount } = await pool.query(
        `update subscriptions
            set plan_id = 'free', status = 'canceled', cancel_at_period_end = false, updated_at = now()
          where stripe_customer_id = $1`,
        [sub.customer],
      );
      return rowCount === 0 ? "unmatched" : "applied";
    }

    // 결제 실패 — 즉시 강등하지 않는다. Stripe가 며칠에 걸쳐 재시도하며,
    // 첫 실패에 서비스를 끊으면 카드 만료 같은 사소한 사유로 고객을 잃는다.
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const { rowCount } = await pool.query(
        `update subscriptions set status = 'past_due', updated_at = now()
          where stripe_customer_id = $1`,
        [inv.customer],
      );
      return rowCount === 0 ? "unmatched" : "applied";
    }

    case "invoice.payment_succeeded": {
      const inv = event.data.object;
      const { rowCount } = await pool.query(
        `update subscriptions set status = 'active', updated_at = now()
          where stripe_customer_id = $1 and status = 'past_due'`,
        [inv.customer],
      );
      return rowCount === 0 ? "ignored" : "applied";
    }

    default:
      return "ignored"; // 관심 없는 이벤트는 200으로 무시 — Stripe 재전송 폭주 방지
  }
}
