import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { evidenceStatusMessages, numberedExcerpt, type EvidenceView, type MessageEvidencePresentation } from "../lib/evidence.js";
import { Modal } from "./Modal.js";

/** 답변 아래의 근거 목록. 버튼은 해당 구간의 원문 확인 대화 상자를 연다. */
export function EvidenceList({ evidence, onOpen }: { evidence: MessageEvidencePresentation; onOpen: (sourceId: string) => void }) {
  return <div className="evidence small" data-testid="message-evidence">
    <div className="muted">{evidence.summary}{evidence.undelivered.length > 0 && ` · 전달되지 않은 파일: ${evidence.undelivered.join(", ")}`}</div>
    {evidence.notes.map((note) => <div className="muted" key={note}>{note}</div>)}
    {evidence.sources.length > 0 && <ul className="evidence-sources">{evidence.sources.map((source) => <li key={source.id}>
      <button type="button" className="evidence-link" aria-label={`${source.label} 근거 원문 열기`} onClick={() => onOpen(source.id)}>{source.id} · {source.label}</button>
    </li>)}</ul>}
  </div>;
}

export function EvidenceDialog({ sessionId, messageId, sourceId, fallback, onClose }: {
  sessionId: string; messageId: string; sourceId: string;
  /** 답변과 함께 받은 전달 원문. 열람 API가 실패해도 무엇을 보냈는지는 보여 준다. */
  fallback?: { label: string; excerpt: string; startLine: number };
  onClose: () => void;
}) {
  const [view, setView] = useState<EvidenceView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setView(await api<EvidenceView>(`/v1/sessions/${sessionId}/messages/${messageId}/evidence/${sourceId}`, { signal: AbortSignal.timeout(12000) })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [sessionId, messageId, sourceId]);
  useEffect(() => { void load(); }, [load]);
  const excerpt = view ? { excerpt: view.excerpt, startLine: view.source.startLine } : fallback;
  return <Modal title="근거 구간 확인" onClose={onClose}>
    <p className="small" data-testid="evidence-source">{view ? `${sourceId} · ${view.source.fileName} · ${view.source.startLine}–${view.source.endLine}행` : fallback?.label ?? sourceId}</p>
    {loading && <p role="status">파일과 대조하는 중…</p>}
    {error && <div role="alert" className="alert">근거를 파일과 대조하지 못했습니다: {error} <button onClick={() => void load()}>다시 시도</button></div>}
    {view && <ul className="evidence-status" data-testid="evidence-status">{evidenceStatusMessages(view).map((item) =>
      <li key={item.text} className={`badge ${item.tone}`} role={item.tone === "err" ? "alert" : undefined}>{item.text}</li>)}</ul>}
    <p className="small">전달된 구간은 답변이 정확하다는 보증이 아닙니다. 답변에 적힌 값과 행 번호를 아래 원문과 직접 비교하세요.</p>
    {excerpt && <section aria-label="모델에 전달된 원문">
      <h3 className="small">모델에 전달된 원문</h3>
      <ul className="evidence-lines" data-testid="evidence-excerpt">{numberedExcerpt(excerpt.excerpt, excerpt.startLine).map((line) =>
        <li key={line.number}><span className="line-no">{line.number}행</span><code>{line.text || " "}</code></li>)}</ul>
    </section>}
    {view?.context && <section aria-label="현재 파일의 해당 위치">
      <h3 className="small">현재 파일의 해당 위치 (앞뒤 3행 포함)</h3>
      <ul className="evidence-lines" data-testid="evidence-context">{view.context.lines.map((line) =>
        <li key={line.number} className={line.cited ? "cited" : undefined}><span className="line-no">{line.number}행</span>
          {line.cited ? <mark><code>{line.text || " "}</code></mark> : <code>{line.text || " "}</code>}
          {line.cited && <span className="sr-only"> (전달된 행)</span>}</li>)}</ul>
      {view.context.truncated && <p className="small muted">긴 구간이라 처음 300행만 보여 줍니다.</p>}
    </section>}
  </Modal>;
}
