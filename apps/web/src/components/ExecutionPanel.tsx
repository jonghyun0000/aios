import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { Modal } from "./Modal.js";

interface Action {
  id: string; tool_name: string; status: string; purpose: string; arguments: { path?: string; command?: string; cwd?: string };
  output: string; exit_code: number | null; checkpoint: boolean; restored_at: string | null; decided_at: string | null;
  before_hash: string | null; after_hash: string | null; expires_at: string | null;
  preview: { before: string | null; after: string } | null;
}
interface Run { id: string; status: string; summary: string; created_at: string; workspace_root: string; actions: Action[] }
const label: Record<string, string> = { running: "실행 중", pending: "승인 대기", approved: "승인됨", rejected: "거절됨", expired: "승인 만료", passed: "실행 성공", failed: "실패·확인 필요", cancelled: "중단됨", interrupted: "연결 중단·확인 필요", verified: "지정 검증 통과", unverified: "동작 미검증", restored: "복구됨", restoring: "복구 중", restore_conflict: "복구 보류" };

export function ExecutionPanel({ sessionId, revision, sending }: { sessionId: string; revision: number; sending: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [restore, setRestore] = useState<Action | null>(null);
  const recordsId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let poll = sending;
      try {
        const data = await api<{ runs: Run[] }>(`/v1/sessions/${sessionId}/executions`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
        if (!Array.isArray(data.runs) || data.runs.some((run) => !Array.isArray(run.actions))) throw new Error("실행 기록 응답 형식이 올바르지 않습니다. 다시 확인해 주세요.");
        if (live) { setRuns(data.runs); setLoadError(""); poll ||= data.runs.some((run) => run.status === "running"); }
      } catch (err) { if (live) setLoadError(err instanceof Error ? err.message : String(err)); }
      if (live && poll) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId, revision, sending, refresh]);
  const pending = runs.some((run) => run.actions.some((action) => action.status === "pending"));
  const act = async (action: Action, operation: "approval" | "restore", approve = false) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setOpen(true);
    try {
      const result = await api<{ removedNewFile?: boolean }>(`/v1/sessions/${sessionId}/executions/${action.id}/${operation}`, { method: "POST", body: JSON.stringify(operation === "approval" ? { approve } : { confirm: true }), signal: AbortSignal.timeout(15000) });
      setNotice(operation === "restore" ? result.removedNewFile ? "이번 작업이 만든 새 파일을 제거했습니다. 변경 전·후 내용은 실행 기록에 보관됩니다." : "변경 전 내용으로 복구했습니다." : approve ? "이번 작업 1건을 승인했습니다." : "작업을 거절했습니다.");
      setRestore(null);
      if (operation === "approval") toggle.current?.focus({ preventScroll: true });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); setRefresh((value) => value + 1); }
  };
  return <section className="execution-panel" aria-label="실행 안전 기록">
    <h2 className="sr-only">실행 안전 기록</h2>
    <button ref={toggle} className="execution-toggle" aria-controls={open || pending ? recordsId : undefined} aria-expanded={open || pending} onClick={() => setOpen(!open)}>
      {pending ? "승인 대기 — 실행 내용을 확인해 주세요" : `실행 기록${runs[0] ? ` · ${label[runs[0].status] ?? runs[0].status}` : ""}`} <span aria-hidden>{open || pending ? "▴" : "▾"}</span>
    </button>
    {(error || loadError) && <div className="alert small" role="alert">{error || loadError}<button onClick={() => setRefresh((value) => value + 1)}>다시 확인</button></div>}
    {notice && <div className="small" role="status">{notice}</div>}
    {(open || pending) && <div className="execution-records" id={recordsId} role="region" aria-label="승인과 실행 결과" tabIndex={0}>
      <p className="small muted">검증 결과는 실행 당시의 상태입니다. 이후 변경하면 다시 검증하세요. 명령은 네트워크 차단·작업 폴더 읽기 전용입니다. 최근 20회 기록을 표시합니다.</p>
      {!runs.length && <p className="small muted">도구를 사용하면 승인 요청과 실행 결과가 여기에 남습니다.</p>}
      {runs.map((run, index) => <details key={run.id} open={index === 0} className="execution-run">
        <summary>{label[run.status] ?? run.status} · {new Date(run.created_at).toLocaleString("ko-KR")}</summary>
        <p className="small" data-testid="execution-summary">{run.summary || "도구 요청 또는 사용자 승인을 기다리고 있습니다."}</p>
        <p className="small muted execution-path">작업 폴더: {run.workspace_root}</p>
        {run.actions.map((action) => <article key={action.id} className={`execution-action ${action.status === "pending" ? "approval-pending" : ""}`}>
          <div className="row-between"><strong>{action.purpose === "verification" ? "지정 검증 명령" : action.tool_name}</strong><span className="badge">{label[action.status] ?? action.status}</span></div>
          {action.arguments.path && <p className="execution-path">파일: {action.arguments.path}</p>}
          {action.arguments.command && <><pre role="region" aria-label="실행할 명령" tabIndex={0}>{action.arguments.command}</pre><p className="small muted">위치: {action.arguments.cwd ?? "."} · 작업 폴더 읽기 전용 · 네트워크 없음</p></>}
          {action.preview && <details open={action.status === "pending"}><summary>변경 전·후 전체 내용{action.preview.before === null ? " · 새 파일" : ""}</summary>
            <div className="change-preview"><div><h3>변경 전</h3><pre role="region" aria-label="변경 전 전체 내용" tabIndex={0}>{action.preview.before ?? "(파일 없음)"}</pre></div><div><h3>변경 후</h3><pre role="region" aria-label="변경 후 전체 내용" tabIndex={0}>{action.preview.after || "(빈 파일)"}</pre></div></div>
            <p className="small muted execution-path">저장 후 SHA-256: {action.after_hash}</p>
          </details>}
          {action.status === "pending" && <div className="approval-controls" role="group" aria-label="위험 작업 승인">
            <p className="small">아직 실행하지 않았습니다. {action.expires_at ? new Date(action.expires_at).toLocaleTimeString("ko-KR") : "5분 뒤"} 승인 만료. 이번 1건에만 적용됩니다.</p>
            <button className="primary" disabled={busy} onClick={() => void act(action, "approval", true)}>이번 작업 승인</button>{" "}<button disabled={busy} onClick={() => void act(action, "approval", false)}>거절하고 중단</button>
          </div>}
          {action.exit_code !== null && <p className="small">실제 종료 코드: <strong>{action.exit_code}</strong></p>}
          {action.output && <details><summary>실행 결과 보기</summary><pre role="region" aria-label="명령 실행 결과 전체 내용" tabIndex={0}>{action.output}</pre></details>}
          {action.checkpoint && action.decided_at && !action.restored_at && !["pending", "approved", "running", "rejected", "expired"].includes(action.status) && <button disabled={busy || sending} onClick={() => setRestore(action)}>이 변경 복구</button>}
        </article>)}
      </details>)}
    </div>}
    {restore && <Modal title="파일 변경 복구" busy={busy} onClose={() => setRestore(null)}>
      <p className="execution-path">{restore.arguments.path}</p>
      <p>{restore.before_hash === null ? "이 작업이 만든 새 파일을 제거합니다." : "이 작업 직전의 파일 내용으로 되돌립니다."} 이후 직접 수정된 파일은 덮어쓰지 않습니다. 여러 번 바꾼 파일은 최신 변경부터 복구하세요.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <button className="danger" disabled={busy} onClick={() => void act(restore, "restore")}>확인하고 복구</button>
    </Modal>}
  </section>;
}
