import { get, apiKeyStore } from "../lib/api.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { useAuth } from "../lib/auth.js";
import { LocalOperations } from "../components/LocalOperations.js";

interface SessionInfo {
  session: {
    user_id: string;
    email: string;
    display_name: string | null;
    avatar_url: string | null;
    expires_at: string;
    organizations: { orgId: string; role: string; name: string }[] | null;
  };
}

export function SettingsPage() {
  const { me, signOut } = useAuth();
  // API 키 로그인에는 세션이 없으므로 404가 정상이다. 그 경우 에러 대신 안내를 보여준다.
  const session = useAsync(() => get<SessionInfo>("/v1/auth/session").catch(() => null), []);

  return (
    <div className="main-narrow" style={{ maxWidth: 700 }}>
      <h1>설정</h1>
      <p className="page-sub">{me?.via === "local" ? "내 컴퓨터 운영과 계정 정보입니다." : "계정과 조직 정보입니다."}</p>

      {me?.via === "local" && me.role === "owner" && <LocalOperations />}

      <h2>인증</h2>
      <div className="card">
        <table>
          <tbody>
            <tr><th>조직</th><td className="mono">{me?.orgId}</td></tr>
            <tr><th>사용자</th><td className="mono">{me?.userId ?? (me?.via === "local" ? "내 컴퓨터 사용자" : "(API 키 — 사람 주체 없음)")}</td></tr>
            <tr><th>역할</th><td><span className="badge">{me?.role}</span></td></tr>
            <tr>
              <th>방식</th>
              <td>
                <span className="badge">{me?.via}</span>{" "}
                <span className="small muted">
                  {me?.via === "session" && "OAuth 세션 (HttpOnly 쿠키 — JavaScript가 읽을 수 없음)"}
                  {me?.via === "api_key" && `API 키 (${apiKeyStore.location() === "local" ? "이 브라우저에 저장됨" : "이 탭에만 저장 — 탭을 닫으면 사라짐"})`}
                  {me?.via === "jwt" && "외부 IdP JWT"}
                  {me?.via === "local" && "내 컴퓨터 전용 · 로그인 불필요"}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>세션</h2>
      <AsyncBoundary loading={session.loading} error={session.error}>
        {session.data?.session ? (
          <div className="card">
            <table>
              <tbody>
                <tr><th>이메일</th><td>{session.data.session.email}</td></tr>
                <tr><th>이름</th><td>{session.data.session.display_name ?? "-"}</td></tr>
                <tr>
                  <th>만료</th>
                  <td>{new Date(session.data.session.expires_at).toLocaleString("ko-KR")}</td>
                </tr>
              </tbody>
            </table>
            {session.data.session.organizations && (
              <>
                <h2 style={{ marginTop: 18 }}>소속 조직</h2>
                <table>
                  <thead><tr><th>조직</th><th>역할</th></tr></thead>
                  <tbody>
                    {session.data.session.organizations.map((o) => (
                      <tr key={o.orgId}>
                        <td>{o.name} <span className="mono small muted">{o.orgId.slice(0, 8)}…</span></td>
                        <td><span className="badge">{o.role}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        ) : (
          me?.via === "local" ? <div className="alert info">로그인 없이 이 컴퓨터에서 사용 중입니다. 작업 파일은 <code>{me.workspaceRoot}</code>에 저장됩니다.</div> : <div className="alert info">
            OAuth 세션이 없습니다. API 키로 로그인한 상태이며, 이 키는 탭을 닫으면 사라집니다.
          </div>
        )}
      </AsyncBoundary>

      {me?.via !== "local" && <><h2>위험 구역</h2>
      <button className="danger" onClick={() => void signOut()}>로그아웃</button></>}
    </div>
  );
}
