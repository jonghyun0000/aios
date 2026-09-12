import { useState } from "react";
import { get, post, type PlanRow, type SubscriptionView } from "../lib/api.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { useAuth } from "../lib/auth.js";

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

/** plans.id를 Stripe price lookup_key로 그대로 쓴다 — 웹훅이 lookup_key로 플랜을 되돌려주므로 짝이 맞아야 한다. */
const priceIdFor = (planId: string) => `price_${planId}_monthly`;

export function BillingPage() {
  const { me } = useAuth();
  const plans = useAsync(() => get<{ plans: PlanRow[] }>("/v1/billing/plans"), []);
  const sub = useAsync(() => get<SubscriptionView>("/v1/billing/subscription"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOwner = me ? ROLE_RANK[me.role] >= ROLE_RANK.owner : false;

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError(null);
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const checkout = (planId: string) =>
    act(planId, async () => {
      const r = await post<{ checkoutUrl: string }>("/v1/billing/checkout", { priceId: priceIdFor(planId) });
      // Stripe 호스팅 결제 페이지로 이동한다. 카드 정보가 우리 서버를 지나가지 않는다.
      window.location.href = r.checkoutUrl;
    });

  const portal = () =>
    act("portal", async () => {
      const r = await post<{ portalUrl: string }>("/v1/billing/portal", {});
      window.location.href = r.portalUrl;
    });

  const cancel = () =>
    act("cancel", async () => {
      await post("/v1/billing/cancel", { immediately: false });
      sub.reload();
    });

  if (me?.via === "local") return <div className="main-narrow">
    <h1>결제</h1><p className="page-sub">내 컴퓨터의 로컬 모델을 사용합니다.</p>
    <div className="card">현재 로컬 실행에는 외부 AI API 결제나 구독이 필요하지 않습니다. 클라우드 결제 기능은 연결하지 않았습니다.</div>
  </div>;

  return (
    <div className="main-narrow">
      <h1>결제</h1>
      <p className="page-sub">플랜과 사용량을 관리합니다.</p>

      {error && <div className="alert" role="alert">{error}</div>}
      {!isOwner && (
        <div className="alert info">
          플랜 변경은 owner만 할 수 있습니다. 현재 역할은 <strong>{me?.role}</strong>이므로 조회만 가능합니다.
        </div>
      )}

      <AsyncBoundary loading={sub.loading} error={sub.error}>
        {sub.data && (
          <div className="card">
            <div className="row-between">
              <div>
                <strong style={{ fontSize: 16 }}>{sub.data.subscription.plan_name}</strong>{" "}
                <span className={`badge ${sub.data.subscription.status === "active" ? "ok" : "warn"}`}>
                  {sub.data.subscription.status}
                </span>
                {sub.data.subscription.cancel_at_period_end && (
                  <span className="badge warn" style={{ marginLeft: 6 }}>기간 만료 시 해지 예정</span>
                )}
              </div>
              <div className="mono">
                ${(sub.data.subscription.monthly_price_cents / 100).toFixed(2)}
                <span className="small muted"> /월</span>
              </div>
            </div>

            <div className="small muted" style={{ marginTop: 10 }}>
              이번 주기 {sub.data.usage.tokens.toLocaleString()} 토큰 사용
              {sub.data.usage.includedTokens > 0 &&
                ` (포함량 ${sub.data.usage.includedTokens.toLocaleString()}, ${sub.data.usage.percentUsed}%)`}
              {" · "}${(sub.data.usage.costCents / 100).toFixed(2)}
              {sub.data.subscription.current_period_end &&
                ` · 다음 갱신 ${new Date(sub.data.subscription.current_period_end).toLocaleDateString("ko-KR")}`}
            </div>

            {isOwner && (
              <div className="row" style={{ marginTop: 14 }}>
                <button onClick={() => void portal()} disabled={busy !== null || !sub.data.subscription.has_payment_method}>
                  {busy === "portal" ? "여는 중…" : "결제 수단 관리"}
                </button>
                {sub.data.subscription.plan_id !== "free" && !sub.data.subscription.cancel_at_period_end && (
                  <button className="danger" onClick={() => void cancel()} disabled={busy !== null}>
                    {busy === "cancel" ? "처리 중…" : "구독 해지"}
                  </button>
                )}
              </div>
            )}
            {isOwner && !sub.data.subscription.has_payment_method && (
              <p className="small muted" style={{ marginBottom: 0 }}>
                결제 수단이 등록되면 관리 버튼이 활성화됩니다.
              </p>
            )}
          </div>
        )}
      </AsyncBoundary>

      <h2>플랜</h2>
      <AsyncBoundary loading={plans.loading} error={plans.error}>
        <div className="grid grid-3">
          {plans.data?.plans.map((p) => {
            const isCurrent = sub.data?.subscription.plan_id === p.id;
            return (
              <div className="card" key={p.id} style={isCurrent ? { borderColor: "var(--accent)" } : undefined}>
                <div className="row-between">
                  <strong>{p.name}</strong>
                  {isCurrent && <span className="badge ok">현재</span>}
                </div>
                <div style={{ fontSize: 20, margin: "6px 0" }}>
                  ${(p.monthly_price_cents / 100).toFixed(0)}
                  <span className="small muted"> /월</span>
                </div>
                <div className="small muted">
                  {Number(p.included_tokens) > 0
                    ? `${Number(p.included_tokens).toLocaleString()} 토큰 포함`
                    : "토큰 별도 과금"}
                </div>
                <ul className="small muted" style={{ paddingLeft: 16, margin: "8px 0" }}>
                  {Object.entries(p.limits).map(([k, v]) => (
                    <li key={k}>{k}: {String(v)}</li>
                  ))}
                </ul>
                {isOwner && !isCurrent && p.monthly_price_cents > 0 && (
                  <button
                    className="primary"
                    style={{ width: "100%" }}
                    disabled={busy !== null}
                    onClick={() => void checkout(p.id)}
                  >
                    {busy === p.id ? "결제 페이지로…" : `${p.name}으로 변경`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </AsyncBoundary>

      <p className="small muted" style={{ marginTop: 18 }}>
        결제는 Stripe 호스팅 페이지에서 처리됩니다. 카드 정보는 이 서버를 지나가지 않습니다.
      </p>
    </div>
  );
}
