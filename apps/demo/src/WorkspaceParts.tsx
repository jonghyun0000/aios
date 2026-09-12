import { useEffect, useRef, useState, type Dispatch } from "react";
import { Icon } from "./Icon.js";
import { FILE_PATH, REFERENCE, REFERENCE_PATH, PHASE_LABELS, SCENARIOS, isEvidenceCurrent, type Action, type DemoState, type ScenarioId, type Session } from "./state.js";

export function Sidebar({ state, onSelect, mobileOpen, onClose }: { state: DemoState; onSelect: (id: ScenarioId) => void; mobileOpen: boolean; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (mobileOpen) closeButton.current?.focus(); }, [mobileOpen]);
  return <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`} id="scenario-sidebar" aria-label="프로젝트와 샘플 대화" onKeyDown={(event) => { if (mobileOpen && event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div className="brand-row"><a className="brand" href="https://github.com/jonghyun0000/aios" target="_blank" rel="noopener noreferrer"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>AIOS<span className="brand-small">WORKSPACE</span></a><button className="icon-button mobile-only" ref={closeButton} type="button" aria-label="시나리오 닫기" onClick={onClose}><Icon name="close" /></button></div>
    <div className="workspace-label"><span className="workspace-avatar">A</span><div><strong>샘플 작업공간</strong><span>이 탭에서만, 부담 없이</span></div><span className="tiny-tag">DEMO</span></div>
    <div className="sidebar-section-label">프로젝트</div>
    <div className="project-card"><span className="project-icon"><Icon name="folder" /></span><div><strong>가을 업데이트</strong><span>참고자료와 안내문</span></div><span className="project-dot" aria-hidden="true" /></div>
    <div className="sidebar-section-label conversations-label">체험할 대화<span>3</span></div>
    <nav className="scenario-list" aria-label="체험 시나리오">
      {SCENARIOS.map((scenario, index) => <button key={scenario.id} type="button" data-testid={`demo-scenario-${scenario.id}`} className={`scenario-link ${state.active === scenario.id ? "is-active" : ""}`} aria-pressed={state.active === scenario.id} onClick={() => onSelect(scenario.id)}><span className="scenario-number">0{index + 1}</span><span><strong>{scenario.label}</strong><small>{scenario.description}</small></span><Icon name="chat" size={16} /></button>)}
    </nav>
    <div className="sidebar-note"><Icon name="leaf" size={20} /><strong>설치 없이 흐름부터</strong><p>여기서는 모델도, 실제 파일도 실행하지 않습니다. 샘플로 AIOS의 작업 방식을 살펴보세요.</p></div>
    <div className="sidebar-bottom"><span className="memory-dot" />메모리 전용 샘플<span>v0.1</span></div>
  </aside>;
}

export function Progress({ session }: { session: Session }) {
  const position = session.phase === "ready" ? 0 : ["awaiting_approval", "rejected"].includes(session.phase) ? 1 : ["applied", "verified", "verification_failed"].includes(session.phase) ? 2 : 3;
  return <ol className="flow-steps" aria-label="체험 순서">{["자료 확인", "변경 승인", "결과 검증", "안전한 복구"].map((step, index) => <li key={step} className={position === index ? "is-current" : ""} aria-current={position === index ? "step" : undefined}><span>{index + 1}</span>{step}{index < 3 ? <span className="step-line" aria-hidden="true" /> : null}</li>)}</ol>;
}

export function EvidencePanel({ session, dispatch }: { session: Session; dispatch: Dispatch<Action> }) {
  const [fileTab, setFileTab] = useState<"file" | "reference">("file");
  const proposal = session.proposal;
  const send = (type: "APPROVE" | "REJECT" | "VERIFY" | "MANUAL_EDIT" | "RESTORE") => { if (proposal) dispatch({ type, scenario: session.id, proposalId: proposal.id }); };
  const mayVerify = ["applied", "manually_edited"].includes(session.phase);
  const mayRestore = ["applied", "verified", "verification_failed", "manually_edited", "restore_conflict"].includes(session.phase);
  const mayEdit = ["applied", "verified", "verification_failed"].includes(session.phase);
  const evidenceCurrent = isEvidenceCurrent(session);
  return <>
    <div className="evidence-heading"><div><p className="eyebrow">작업을 살펴보는 창</p><h2 id="evidence-title">변경과 근거</h2></div><span className="outline-tag"><Icon name="shield" size={13} />샘플</span></div>
    <section className="file-panel" aria-labelledby="virtual-files-title">
      <h3 id="virtual-files-title" className="section-title"><Icon name="folder" size={16} />가상 파일<span className="small-muted">메모리 안의 텍스트</span></h3>
      <div className="file-tabs" role="group" aria-label="샘플 파일 선택"><button type="button" className={fileTab === "file" ? "is-selected" : ""} aria-pressed={fileTab === "file"} onClick={() => setFileTab("file")}><Icon name="file" size={14} />launch.md</button><button type="button" className={fileTab === "reference" ? "is-selected" : ""} aria-pressed={fileTab === "reference"} onClick={() => setFileTab("reference")}><Icon name="file" size={14} />brief.txt<span>자료</span></button></div>
      <div className="file-path">{fileTab === "file" ? FILE_PATH : REFERENCE_PATH}<span>가상</span></div>
      <pre className="file-content" role="region" aria-label={fileTab === "file" ? "현재 가상 파일 내용" : "샘플 참고자료 내용"} tabIndex={0} data-testid={fileTab === "file" ? "demo-file-content" : "demo-reference-content"}>{fileTab === "file" ? session.content : REFERENCE}</pre>
      <p className="file-caption"><span className="memory-dot" />실제 컴퓨터의 파일과 연결되지 않습니다.</p>
    </section>

    {proposal ? <section className={`approval-panel ${session.phase === "awaiting_approval" ? "is-pending" : ""}`} aria-labelledby="change-title">
      <div className="panel-title-row"><h3 id="change-title"><Icon name="shield" size={17} />이번 변경</h3><span className="small-muted">파일 1개</span></div>
      <p className="change-description">브리프에 맞춰 출시일과 문의 안내를 반영합니다.</p>
      <details className="change-details" open={session.phase === "awaiting_approval" || undefined}><summary>변경 전후 비교<span>텍스트</span></summary><div className="diff-part"><div><span className="diff-sign">−</span>변경 전</div><pre data-testid="demo-proposal-before">{proposal.before}</pre></div><div className="diff-part after"><div><span className="diff-sign">+</span>제안 내용</div><pre data-testid="demo-proposal-after">{proposal.after}</pre></div></details>
      {session.phase === "awaiting_approval" ? <><div className="approval-explanation">{session.id === "failure" ? <><Icon name="warning" size={16} /><span>이 실습은 승인 후 날짜 누락 오류를 주입합니다. 검증이 차이를 찾는지 확인해 보세요.</span></> : <><Icon name="shield" size={16} /><span>승인 전에는 가상 파일도 바뀌지 않습니다. 승인은 이 변경 한 번에만 적용됩니다.</span></>}</div><div className="approval-buttons"><button className="button primary" type="button" data-testid="demo-approve" onClick={() => send("APPROVE")}><Icon name="check" size={16} />승인하고 가상 수정</button><button className="button secondary" type="button" data-testid="demo-reject" onClick={() => send("REJECT")}>거절</button></div></> : <p className="decision-note">{session.phase === "rejected" ? "거절된 제안입니다. 파일은 변경하지 않았습니다." : "승인된 제안입니다. 아래에서 결과와 복구 가능성을 확인하세요."}</p>}
    </section> : <div className="evidence-empty"><span className="empty-icon"><Icon name="shield" size={24} /></span><h3>먼저 보여 주고,<br />그다음 승인받습니다.</h3><p>샘플 제안을 만들면 이곳에서 변경 전후와 검증 근거를 확인할 수 있습니다.</p></div>}

    {session.checkpoint ? <section className="verification-panel" aria-labelledby="verification-title"><div className="panel-title-row"><h3 id="verification-title"><Icon name="check" size={17} />결과 검증</h3><span className="small-muted">문자열 비교</span></div><p className="section-description">실제 가상 파일의 출시일·문의 주소·전체 내용을 비교합니다. 코드는 실행하지 않습니다.</p><button type="button" className="button primary full-width" data-testid="demo-verify" disabled={!mayVerify} onClick={() => send("VERIFY")}>{mayVerify ? "샘플 검증하기" : session.evidence ? "검증 기록 확인" : "이 상태에서는 검증할 수 없음"}<Icon name="arrow" size={16} /></button>
      {session.evidence ? <div className={`verification-results ${!evidenceCurrent ? "is-stale" : ""}`} data-testid="demo-verification-results"><p className="verification-result-label">{!evidenceCurrent ? "이전 검증 기록 · 현재 파일의 결과가 아닙니다" : session.evidence.passed ? "샘플 텍스트 비교 통과" : "불일치 발견 · 검증 실패"}</p>{session.evidence.checks.map((item) => <div className="check-result" key={item.label}><span className={`check-icon ${item.passed ? "pass" : "fail"}`}>{item.passed ? <Icon name="check" size={13} /> : <Icon name="close" size={13} />}</span><div><strong>{item.label}</strong><dl><div><dt>기대</dt><dd>{item.expected}</dd></div><div><dt>실제</dt><dd>{item.actual}</dd></div></dl></div></div>)}</div> : <p className="pending-verification">아직 검증하지 않았습니다.</p>}
    </section> : null}

    {session.checkpoint ? <section className="restore-panel" aria-labelledby="restore-title"><div className="panel-title-row"><h3 id="restore-title"><Icon name="restore" size={17} />변경 복구</h3><span className="small-muted">원본 보관됨</span></div><p className="section-description">현재 내용이 가상 수정 직후와 같을 때만 원본으로 되돌립니다.</p><button className="button secondary full-width" type="button" data-testid="demo-manual-edit" disabled={!mayEdit} onClick={() => send("MANUAL_EDIT")}>수동 수정 충돌 만들기<Icon name="plus" size={15} /></button><button className="button secondary full-width" type="button" data-testid="demo-restore" disabled={!mayRestore || session.phase === "restore_conflict"} onClick={() => send("RESTORE")}><Icon name="restore" size={16} />원본으로 복구</button>{session.phase === "restore_conflict" ? <p className="inline-warning" role="alert">복구를 차단했습니다. 직접 수정한 메모를 보존했으며 강제로 덮어쓰지 않았습니다.</p> : session.phase === "restored" ? <p className="inline-success">변경 전 원본으로 복구했습니다. 이전 검증 결과는 무효입니다.</p> : null}</section> : null}

    {session.audits.length > 0 ? <section className="audit-panel" aria-labelledby="audit-title"><h3 id="audit-title">이 대화의 체험 기록</h3><ol>{session.audits.map((item) => <li key={item.id}><span className={`audit-dot ${item.tone}`} /><div><strong>{item.label}</strong><p>{item.detail}</p></div></li>)}</ol></section> : null}
  </>;
}

export function SourceFooter() {
  return <footer className="source-footer"><span>실제 구현은 코드로 확인하세요.</span><div><a href="https://github.com/jonghyun0000/aios" target="_blank" rel="noopener noreferrer">GitHub<Icon name="external" size={12} /></a><a href="https://github.com/jonghyun0000/aios/tree/main/apps/demo" target="_blank" rel="noopener noreferrer">데모 소스<Icon name="external" size={12} /></a><a href="https://github.com/jonghyun0000/aios/blob/main/docs/19-stage3-execution-safety.md" target="_blank" rel="noopener noreferrer">안전 실행 문서<Icon name="external" size={12} /></a></div></footer>;
}

export function Status({ session }: { session: Session }) {
  const warning = ["awaiting_approval", "verification_failed", "restore_conflict", "manually_edited"].includes(session.phase);
  const good = ["verified", "restored"].includes(session.phase);
  return <span className={`phase-status ${warning ? "warning" : good ? "good" : ""}`} data-testid="demo-status"><span />{PHASE_LABELS[session.phase]}</span>;
}
