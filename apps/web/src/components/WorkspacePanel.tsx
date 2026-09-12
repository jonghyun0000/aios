import { useCallback, useEffect, useState } from "react";
import { api, post, del } from "../lib/api.js";
import { useSessions } from "../lib/sessions.js";
import { Modal } from "./Modal.js";

export interface WorkspaceState {
  session: { id: string; title: string | null; project_id: string | null; deleted_at: string | null };
  files: { id: string; name: string; project_id: string | null; bytes: number }[];
}
export function WorkspacePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { refresh } = useSessions();
  const [data, setData] = useState<WorkspaceState | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectName, setProjectName] = useState("");
  const [scope, setScope] = useState("session");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [workspace, list] = await Promise.all([
      api<WorkspaceState>(`/v1/sessions/${sessionId}/workspace`, { signal: AbortSignal.timeout(12000) }),
      api<{ projects: { id: string; name: string }[] }>("/v1/projects", { signal: AbortSignal.timeout(12000) }),
    ]);
    setData(workspace); setProjects(list.projects);
  }, [sessionId]);
  useEffect(() => { void load().catch((err: Error) => setError(err.message)).finally(() => setBusy(false)); }, [load]);
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); refresh(); setNotice(message); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const linkProject = (projectId: string | null) => api(`/v1/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ projectId }) });
  return <Modal title="자료·프로젝트" onClose={onClose} busy={busy}>
    <p className="small muted">이 대화의 참고자료를 관리합니다. 프로젝트 자료는 같은 프로젝트의 대화에서 공유됩니다.</p>
    {error && <div role="alert" className="alert">{error}<button disabled={busy} onClick={() => void mutate(load, "다시 불러왔습니다.")}>다시 불러오기</button></div>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">저장소와 연결 중…</p>}
    {data?.session.deleted_at ? <p>휴지통에서 대화를 먼저 복구해 주세요.</p> : data && <>
      <label>연결 프로젝트<select aria-label="연결 프로젝트" value={data.session.project_id ?? ""} disabled={busy} onChange={(e) => { setScope("session"); void mutate(() => linkProject(e.target.value || null), "프로젝트 연결을 변경했습니다."); }}>
        <option value="">프로젝트 없음</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <form className="workspace-actions" onSubmit={(e) => { e.preventDefault(); void mutate(async () => {
        const project = await post<{ id: string }>("/v1/projects", { name: projectName.trim() });
        setProjectName("");
        try { await linkProject(project.id); }
        catch { await load(); throw new Error("프로젝트는 생성했지만 대화 연결에 실패했습니다. ‘연결 프로젝트’ 목록에서 다시 선택해 주세요."); }
      }, "새 프로젝트를 만들고 연결했습니다."); }}>
        <input aria-label="새 프로젝트 이름" placeholder="새 프로젝트 이름" maxLength={200} value={projectName} disabled={busy} onChange={(e) => setProjectName(e.target.value)} />
        <button disabled={busy || !projectName.trim()}>프로젝트 만들기</button>
      </form>
      <p className="small muted">프로젝트는 대화·참고자료를 묶는 공간입니다. 컴퓨터 폴더를 자동 탐색하거나 도구의 작업 폴더를 바꾸지 않습니다.</p>
      <hr /><h3>참고 파일 {data.files.length > 0 && `· ${data.files.length}`}</h3>
      {data.files.length === 0 && <p className="small muted">아직 연결한 자료가 없습니다.</p>}
      <ul className="reference-list">{data.files.map((file) => <li key={file.id}>
        <div><span>{file.name}</span><small className="muted">{file.project_id ? "프로젝트 공용" : "이 대화"} · {(file.bytes / 1024).toFixed(1)}KB</small></div>
        <button disabled={busy} aria-label={`${file.name} 연결 해제`} onClick={() => setRemoveId(file.id)}>해제</button>
      </li>)}</ul>
      {removeId && <div className="alert"><p>참고자료 연결을 해제할까요? 프로젝트 공용 파일이면 연결된 모든 대화에 적용됩니다. 원본 파일은 바뀌지 않습니다.</p><div className="workspace-actions"><button disabled={busy} onClick={() => setRemoveId(null)}>취소</button><button disabled={busy} onClick={() => void mutate(async () => { await del(`/v1/sessions/${sessionId}/files/${removeId}`); setRemoveId(null); }, "연결을 해제했습니다.")}>연결 해제 확인</button></div></div>}
      <label>파일 적용 범위<select aria-label="파일 적용 범위" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)}><option value="session">이 대화에만</option><option value="project" disabled={!data.session.project_id}>프로젝트 공용</option></select></label>
      <label className="file-picker">텍스트·코드 파일 연결<input type="file" aria-label="참고 파일 선택" disabled={busy} accept=".txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.sql,.yaml,.yml,.xml,.log" onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = "";
        if (!file) return;
        void mutate(async () => {
          if (file.size > 65536) throw new Error("파일은 64KB 이하여야 합니다.");
          const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          await post(`/v1/sessions/${sessionId}/files`, { name: file.name, content, scope });
        }, "파일의 텍스트 사본을 저장했습니다. 다음 질문부터 참고합니다.");
      }} /></label>
      <p className="small muted">UTF-8 · 파일당 64KB · 대화/프로젝트 각각 최대 8개. PDF·이미지·Word는 아직 지원하지 않습니다. 질문과 관련된 일부 구간을 참고하며, 원본 변경은 자동 동기화되지 않습니다. 비밀 키가 든 파일은 연결하지 마세요.</p>
    </>}
  </Modal>;
}
