import { ProviderError } from "@aios/shared";

/**
 * Stripe REST 클라이언트 (아웃바운드).
 *
 * SDK를 쓰지 않는 이유는 stripe.ts에 적은 그대로다 — 우리가 호출하는 엔드포인트는
 * 3개뿐이고, Stripe API는 안정적인 form-encoded REST다. SDK를 들이면 콜드스타트와
 * 의존성 트리를 얻는 대신 얻는 것이 타입 자동완성뿐이다.
 *
 * 다만 SDK가 공짜로 주던 두 가지는 직접 구현해야 한다:
 *  1) 멱등성 키 — 네트워크 재시도로 결제 세션이 두 번 만들어지면 안 된다.
 *  2) 재시도 — 5xx/네트워크 오류에만, 지수 백오프로.
 */

const RETRY_DELAYS_MS = [200, 800];

/**
 * Stripe는 중첩 객체를 form-encoded의 대괄호 표기로 받는다 (line_items[0][price]).
 *
 * 스칼라만 직렬화한다. 예상 못한 객체가 들어오면 던진다 — String(obj)는
 * "[object Object]"를 조용히 보내고, Stripe는 그걸 유효한 값으로 받아들여
 * 잘못된 가격/수량으로 결제 세션이 만들어진다. 조용한 오류보다 부팅 실패가 낫다.
 */
function scalarToString(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

function toFormBody(obj: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  const emit = (name: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(scalarToString(value))}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => emit(`${name}[${i}]`, item));
      return;
    }
    if (typeof value === "object") {
      parts.push(...toFormBody(value as Record<string, unknown>, name));
      return;
    }
    throw new TypeError(`cannot serialize ${typeof value} at '${name}' for Stripe form body`);
  };

  for (const [key, value] of Object.entries(obj)) {
    emit(prefix ? `${prefix}[${key}]` : key, value);
  }
  return parts;
}

export interface StripeClientOptions {
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class StripeClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(private opts: StripeClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown> | null,
    idempotencyKey?: string,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.opts.secretKey}`,
          "stripe-version": "2024-06-20",
        };
        if (body) headers["content-type"] = "application/x-www-form-urlencoded";
        // 멱등성 키가 있으면 Stripe가 재시도를 중복 생성하지 않고 원래 결과를 돌려준다.
        if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

        const res = await fetch(`${this.baseUrl}${path}`, {
          method: body ? "POST" : "GET",
          headers,
          body: body ? toFormBody(body).join("&") : undefined,
          signal: controller.signal,
        });

        const text = await res.text();
        if (!res.ok) {
          let message = text.slice(0, 300);
          try {
            const parsed = JSON.parse(text) as { error?: { message?: string } };
            if (parsed.error?.message) message = parsed.error.message;
          } catch { /* 원문 유지 */ }
          const err = new ProviderError("stripe", message, { status: res.status });
          // 4xx는 우리 요청이 틀린 것 — 재시도해도 같은 답이 온다.
          if (!err.retryable) throw err;
          lastError = err;
        } else {
          return JSON.parse(text) as T;
        }
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError("stripe", "request failed", { status: 0 });
  }

  createCustomer(params: { email?: string; name?: string; orgId: string }, idempotencyKey: string) {
    return this.request<{ id: string }>(
      "/v1/customers",
      {
        email: params.email,
        name: params.name,
        // org_id를 metadata에 넣어 웹훅에서 역참조할 수 있게 한다.
        // 이게 없으면 stripe_customer_id로만 조인해야 하고, 첫 웹훅이 고객 생성보다
        // 먼저 도착하는 레이스에서 조직을 찾지 못한다.
        metadata: { org_id: params.orgId },
      },
      idempotencyKey,
    );
  }

  createCheckoutSession(
    params: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; orgId: string },
    idempotencyKey: string,
  ) {
    return this.request<{ id: string; url: string }>(
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        customer: params.customerId,
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.orgId,
        subscription_data: { metadata: { org_id: params.orgId } },
      },
      idempotencyKey,
    );
  }

  /** 고객이 스스로 결제수단·플랜을 관리하는 Stripe 호스팅 포털 */
  createBillingPortalSession(params: { customerId: string; returnUrl: string }, idempotencyKey: string) {
    return this.request<{ url: string }>(
      "/v1/billing_portal/sessions",
      { customer: params.customerId, return_url: params.returnUrl },
      idempotencyKey,
    );
  }

  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean, idempotencyKey: string) {
    return this.request<{ id: string; status: string; cancel_at_period_end: boolean }>(
      `/v1/subscriptions/${subscriptionId}`,
      { cancel_at_period_end: atPeriodEnd },
      idempotencyKey,
    );
  }
}
