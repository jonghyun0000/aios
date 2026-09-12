import { useEffect, useState } from "react";
import { get } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

interface ProvidersResponse {
  providers: string[];
  sessionTtlDays: number;
}

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub으로 계속하기",
  google: "Google로 계속하기",
};

/**
 * 로그인.
 *
 * 두 경로를 제공한다:
 *  1) OAuth — 서버에 설정된 프로바이더만 버튼으로 나온다. 미설정 프로바이더 버튼을
 *     그려두면 사용자가 500을 만난다.
 *  2) API 키 — 자체 호스팅/로컬 개발용. OAuth를 설정하지 않은 배포에서
 *     "로그인할 방법이 아예 없는" 상태를 만들지 않기 위해 반드시 필요하다.
 *     대신 이 방식이 왜 덜 안전한지 화면에 명시한다(키는 XSS로 읽힐 수 있는 저장소에 있다).
 */
export function LoginPage() {
  const { signInWithApiKey } = useAuth();
  const [providers, setProviders] = useState<string[] | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<ProvidersResponse>("/v1/auth/providers")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([])); // 조회 실패해도 API 키 경로는 살아 있어야 한다
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithApiKey(apiKey, remember);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>AIOS 로그인</h1>
        <p className="page-sub small">조직에 접근하려면 인증이 필요합니다.</p>

        {error && <div className="alert" role="alert">{error}</div>}

        {providers === null && <div className="muted small">로그인 방법 확인 중…</div>}

        {providers?.map((p) => (
          <a
            key={p}
            className="btn"
            style={{ display: "block", textAlign: "center", marginBottom: 8 }}
            href={`/v1/auth/${p}/start?redirect_to=${encodeURIComponent(window.location.origin + "/")}`}
          >
            {PROVIDER_LABEL[p] ?? p}
          </a>
        ))}

        {providers?.length === 0 && (
          <div className="alert info small">
            이 서버에는 OAuth 프로바이더가 설정되지 않았습니다. 아래 API 키로 로그인하거나,
            <code> GITHUB_OAUTH_CLIENT_ID</code> 등을 설정한 뒤 서버를 재시작하세요.
          </div>
        )}

        {providers !== null && providers.length > 0 && <div className="divider">또는</div>}

        <form onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor="apikey">API 키</label>
            <input
              id="apikey"
              className="mono"
              type="password"
              autoComplete="off"
              placeholder="aios_live_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <label className="row small" style={{ fontWeight: 400, marginBottom: 12 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            이 브라우저에서 로그인 유지
          </label>
          <button className="primary" type="submit" disabled={busy || apiKey.trim().length === 0}
                  style={{ width: "100%" }}>
            {busy ? "확인 중…" : "API 키로 로그인"}
          </button>
        </form>

        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          {remember
            ? "키가 이 브라우저에 남습니다. 새 탭에서도 로그인 상태가 유지되지만, 공용 PC에서는 권하지 않습니다."
            : "키가 이 탭에만 저장되어 탭을 닫으면 사라집니다. 새 탭을 열면 다시 입력해야 합니다."}
          {" "}
          어느 쪽이든 OAuth 로그인보다는 약합니다 — OAuth는 HttpOnly 쿠키를 써서
          JavaScript가 토큰을 아예 읽을 수 없습니다.
        </p>
      </div>
    </div>
  );
}
