import { useState } from "react";
import { del, get, post, type InstalledRow, type PluginRow, type PluginVersionRow } from "../lib/api.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { useAuth } from "../lib/auth.js";
import { Link } from "../lib/router.js";

interface DetailResponse {
  plugin: PluginRow & { is_owner: boolean };
  versions: PluginVersionRow[];
  rating: { avg: string; count: number };
}

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

export function PluginDetailPage({ slug }: { slug: string }) {
  const { me } = useAuth();
  const detail = useAsync(() => get<DetailResponse>(`/v1/marketplace/plugins/${slug}`), [slug]);
  const installed = useAsync(() => get<{ installed: InstalledRow[] }>("/v1/marketplace/installed"), [slug]);

  const [granted, setGranted] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canInstall = me ? ROLE_RANK[me.role] >= ROLE_RANK.admin : false;
  const current = installed.data?.installed.find((i) => i.slug === slug);
  const approved = detail.data?.versions.filter((v) => v.status === "approved") ?? [];
  const latest = approved[0];
  const declared = latest?.manifest.permissions ?? [];

  // 최초 렌더에서는 선언된 권한을 전부 선택한 상태로 시작한다.
  // 아무것도 선택되지 않은 채로 시작하면 대부분의 플러그인이 설치 후 동작하지 않아
  // 사용자가 이유를 모른 채 "고장났다"고 판단한다.
  const selected = granted ?? new Set(current?.granted_permissions ?? declared);

  const toggle = (perm: string) => {
    const next = new Set(selected);
    if (next.has(perm)) next.delete(perm);
    else next.add(perm);
    setGranted(next);
  };

  const install = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await post<{ version: string }>(`/v1/marketplace/plugins/${slug}/install`, {
        grantedPermissions: [...selected],
      });
      setNotice(`${r.version} 설치 완료`);
      installed.reload();
      detail.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await del(`/v1/marketplace/plugins/${slug}/install`);
      setNotice("제거되었습니다");
      setGranted(null);
      installed.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main-narrow" style={{ maxWidth: 780 }}>
      <p className="small"><Link to="/marketplace">← 마켓플레이스</Link></p>

      <AsyncBoundary loading={detail.loading} error={detail.error}>
        {detail.data && (
          <>
            <div className="row-between">
              <div>
                <h1>{detail.data.plugin.name}</h1>
                <p className="page-sub mono small">{detail.data.plugin.slug}</p>
              </div>
              {current && <span className="badge ok">설치됨 {current.version}</span>}
            </div>

            <p>{detail.data.plugin.description ?? "설명이 없습니다."}</p>
            <div className="row wrap small muted" style={{ marginBottom: 18 }}>
              <span>↓ {Number(detail.data.plugin.downloads).toLocaleString()}</span>
              <span>·</span>
              <span>{detail.data.rating.count > 0 ? `★ ${detail.data.rating.avg}` : "평가 없음"}</span>
              {detail.data.plugin.homepage && (
                <>
                  <span>·</span>
                  <a href={detail.data.plugin.homepage} target="_blank" rel="noreferrer noopener">홈페이지</a>
                </>
              )}
            </div>

            {error && <div className="alert" role="alert">{error}</div>}
            {notice && <div className="alert info" role="status">{notice}</div>}

            <h2>권한</h2>
            {declared.length === 0 ? (
              <p className="small muted">이 플러그인은 어떤 권한도 요구하지 않습니다.</p>
            ) : (
              <div className="card">
                <p className="small muted" style={{ marginTop: 0 }}>
                  manifest가 요구한 권한입니다. 일부만 부여할 수 있으며, 요구되지 않은 권한은 줄 수 없습니다.
                </p>
                {declared.map((perm) => (
                  <label key={perm} className="row" style={{ fontWeight: 400, marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={selected.has(perm)}
                      disabled={!canInstall}
                      onChange={() => toggle(perm)}
                    />
                    <code>{perm}</code>
                  </label>
                ))}
              </div>
            )}

            <div className="row" style={{ marginTop: 16 }}>
              {!canInstall ? (
                <span className="small muted">설치하려면 admin 이상의 역할이 필요합니다 (현재: {me?.role}).</span>
              ) : current ? (
                <>
                  <button className="primary" onClick={() => void install()} disabled={busy || !latest}>
                    권한 다시 적용
                  </button>
                  <button className="danger" onClick={() => void uninstall()} disabled={busy}>제거</button>
                </>
              ) : (
                <button className="primary" onClick={() => void install()} disabled={busy || !latest}>
                  {latest ? `${latest.version} 설치` : "설치 가능한 승인 버전 없음"}
                </button>
              )}
            </div>

            <h2>버전</h2>
            <table>
              <thead>
                <tr><th>버전</th><th>상태</th><th>서명</th><th>SHA-256</th></tr>
              </thead>
              <tbody>
                {detail.data.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.version}</td>
                    <td>
                      <span className={`badge ${v.status === "approved" ? "ok" : v.status === "pending" ? "warn" : "err"}`}>
                        {v.status}
                      </span>
                    </td>
                    <td>{v.signed ? <span className="badge ok">서명됨</span> : <span className="badge">없음</span>}</td>
                    <td className="mono small muted" title={v.bundle_sha256}>{v.bundle_sha256.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              설치 시 런타임이 번들을 내려받아 위 해시와 대조합니다. 불일치하면 로드를 거부합니다.
            </p>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}
