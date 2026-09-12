import { useState } from "react";
import { api, type SessionRow } from "../lib/api.js";
import { useRouter } from "../lib/router.js";
import { useSessions } from "../lib/sessions.js";
import { Modal } from "./Modal.js";

export function SessionActions({ session, onClose }: { session: SessionRow; onClose: () => void }) {
  const sessions = useSessions();
  const { path, navigate } = useRouter();
  const [title, setTitle] = useState(session.title ?? "");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(body: { title?: string; deleted?: boolean }) {
    setBusy(true); setError("");
    try {
      await api(`/v1/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify(body) });
      sessions.refresh();
      if (body.deleted && path === `/chat/${session.id}`) navigate("/chat");
      if (body.deleted === false) { sessions.setTrash(false); navigate(`/chat/${session.id}`); }
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="대화 관리" onClose={onClose} busy={busy}>
    {error && <div role="alert" className="alert">{error}</div>}
    {session.deleted_at ? <><p>휴지통에 있는 대화입니다. 메시지는 그대로 보관되어 있습니다.</p><button className="primary" disabled={busy} onClick={() => void change({ deleted: false })}>대화 복구</button></> : <>
      <form onSubmit={(e) => { e.preventDefault(); void change({ title: title.trim() }); }}>
        <label>대화 이름<input data-modal-initial-focus aria-label="대화 이름" value={title} maxLength={200} disabled={busy} onChange={(e) => setTitle(e.target.value)} /></label>
        <button className="primary" disabled={busy || !title.trim()}>이름 저장</button>
      </form>
      <hr />
      {confirm ? <><p>이 대화를 휴지통으로 옮길까요? 나중에 복구할 수 있습니다.</p><div className="workspace-actions"><button disabled={busy} onClick={() => setConfirm(false)}>취소</button><button className="danger" disabled={busy} onClick={() => void change({ deleted: true })}>휴지통으로 이동</button></div></> : <button className="danger" disabled={busy} onClick={() => setConfirm(true)}>대화 삭제…</button>}
    </>}
  </Modal>;
}
