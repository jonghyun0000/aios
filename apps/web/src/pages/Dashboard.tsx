import { get, type ModelSnapshot, type SubscriptionView, type InstalledRow } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { Link } from "../lib/router.js";

/**
 * 대시보드 — "지금 이 조직이 어떤 상태인가"를 한 화면에.
 *
 * 세 가지만 보여준다: 사용 가능한 모델, 이번 주기 사용량, 설치된 플러그인.
 * 이 셋이 "쓸 수 있는가 / 얼마나 썼는가 / 무엇이 돌고 있는가"에 대한 답이고,
 * 그 밖의 것은 각 페이지에서 보면 된다.
 */
export function DashboardPage() {
  const { me } = useAuth();
  const models = useAsync(() => get<{ models: ModelSnapshot[] }>("/v1/models"), []);
  const billing = useAsync(() => get<SubscriptionView>("/v1/billing/subscription"), []);
  const plugins = useAsync(() => get<{ installed: InstalledRow[] }>("/v1/marketplace/installed"), []);

  // 서킷이 열린 모델은 라우터가 지금 고르지 않는다 → 사용 불가로 표시한다.
  const available = models.data?.models.filter((m) => !m.open) ?? [];
  const unavailable = models.data?.models.filter((m) => m.open) ?? [];

  return (
    <div className="main-narrow">
      <h1>대시보드</h1>
      {me?.via === "local" && <div className="card" style={{ marginBottom: 16 }}>
        <strong>내 컴퓨터에서 바로 시작하세요</strong>
        <p>채팅으로 질문하거나 공공통계를 검색할 수 있습니다. 채팅에서 ‘도구 사용 허용’을 켜면 전용 작업 폴더에 파일을 만들고 실행합니다.</p>
        <div className="row-between"><Link to="/chat">새 대화 시작 →</Link><Link to="/data">공공통계 찾아보기 →</Link></div>
        <p className="small muted">AIOS 시작 터미널을 열어 두세요. 로컬 모델의 답변과 생성한 코드는 확인한 뒤 사용하세요.</p>
      </div>}
      <p className="page-sub">
        조직 <code>{me?.orgId}</code> · 역할 <span className="badge">{me?.role}</span> · 인증{" "}
        <span className="badge">{me?.via}</span>
      </p>

      <h2>사용량</h2>
      <AsyncBoundary loading={billing.loading} error={billing.error}>
        {billing.data && (
          <div className="card">
            <div className="row-between">
              <div>
                <strong>{billing.data.subscription.plan_name}</strong>{" "}
                <span className={`badge ${billing.data.subscription.status === "active" ? "ok" : "warn"}`}>
                  {billing.data.subscription.status}
                </span>
              </div>
              <Link to="/billing">플랜 관리 →</Link>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="row-between small muted">
                <span>
                  {billing.data.usage.tokens.toLocaleString()} /{" "}
                  {billing.data.usage.includedTokens > 0
                    ? billing.data.usage.includedTokens.toLocaleString()
                    : "무제한"}{" "}
                  토큰
                </span>
                <span>${(billing.data.usage.costCents / 100).toFixed(2)}</span>
              </div>
              {/* 무제한 플랜에는 진행 막대를 그리지 않는다 — 분모가 없으면 비율이 거짓말이 된다 */}
              {billing.data.usage.percentUsed !== null && (
                <div
                  style={{
                    height: 6, borderRadius: 3, background: "var(--bg-subtle)",
                    marginTop: 6, overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, billing.data.usage.percentUsed)}%`,
                      background: billing.data.usage.percentUsed > 90 ? "var(--danger)" : "var(--accent)",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </AsyncBoundary>

      <h2>모델 ({available.length}개 사용 가능)</h2>
      <AsyncBoundary loading={models.loading} error={models.error} empty={models.data?.models.length === 0}>
        <div className="grid grid-3">
          {available.map((m) => (
            <div className="card" key={m.model}>
              <div className="row-between">
                <strong className="mono small">{m.model}</strong>
                <span className="badge ok">사용 가능</span>
              </div>
              <div className="small muted">{m.provider}</div>
              <div className="small muted" style={{ marginTop: 6 }}>
                성공률 {(m.successRate * 100).toFixed(0)}% · 지연 {Math.round(m.ewmaLatencyMs)}ms
              </div>
            </div>
          ))}
        </div>
        {unavailable.length > 0 && (
          <p className="small muted" style={{ marginTop: 10 }}>
            서킷 열림 {unavailable.length}개: {unavailable.map((m) => m.model).join(", ")}
            {" — "}연속 실패로 라우터가 잠시 제외했습니다. 복구되면 자동으로 다시 후보가 됩니다.
          </p>
        )}
        <p className="small muted" style={{ marginTop: 6 }}>
          목록에는 API 키가 설정된 프로바이더의 모델만 나타납니다.
        </p>
      </AsyncBoundary>

      <h2>설치된 플러그인</h2>
      <AsyncBoundary
        loading={plugins.loading}
        error={plugins.error}
        empty={plugins.data?.installed.length === 0}
      >
        <table>
          <thead>
            <tr><th>플러그인</th><th>버전</th><th>권한</th></tr>
          </thead>
          <tbody>
            {plugins.data?.installed.map((p) => (
              <tr key={p.slug}>
                <td><Link to={`/marketplace/${p.slug}`}>{p.name}</Link></td>
                <td className="mono small">{p.version}</td>
                <td className="small muted">
                  {p.granted_permissions.length > 0 ? p.granted_permissions.join(", ") : "없음"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AsyncBoundary>
    </div>
  );
}
