import { useEffect, useReducer, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { EvidencePanel, Progress, Sidebar, SourceFooter, Status } from "./WorkspaceParts.js";
import { createInitialState, demoReducer, MAX_MESSAGE_LENGTH, SCENARIOS, type ScenarioId } from "./state.js";
import { shouldSend } from "./keyboard.js";

const blankDrafts: Record<ScenarioId, string> = { normal: "", failure: "", conflict: "" };

export function App() {
  const [state, dispatch] = useReducer(demoReducer, undefined, createInitialState);
  const [drafts, setDrafts] = useState(blankDrafts);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resetIndex, setResetIndex] = useState(0);
  const session = state.sessions[state.active];
  const scenario = SCENARIOS.find((item) => item.id === state.active)!;
  const draft = drafts[state.active];
  const composing = useRef(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const evidence = useRef<HTMLElement>(null);
  const canPropose = ["ready", "rejected", "restored"].includes(session.phase);

  useEffect(() => {
    // 메시지 변화에만 채팅 스크롤을 맞춘다. 승인/전송 같은 작업은 effect에서 실행하지 않는다.
    if (chatScroll.current && session.messages.length > 0) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [session.id, session.messages.length]);

  const closeMenu = () => { setMobileOpen(false); queueMicrotask(() => menuButton.current?.focus()); };
  const select = (id: ScenarioId) => { dispatch({ type: "SELECT", scenario: id }); composing.current = false; if (mobileOpen) closeMenu(); };
  const send = () => {
    if (!draft.trim() || draft.length > MAX_MESSAGE_LENGTH || composing.current) return;
    dispatch({ type: "SEND", scenario: state.active, text: draft });
    setDrafts((current) => ({ ...current, [state.active]: "" }));
    composer.current?.focus();
  };
  const propose = () => {
    dispatch({ type: "PROPOSE", scenario: state.active });
    if (window.matchMedia("(max-width: 1080px)").matches) evidence.current?.scrollIntoView({ block: "start" });
  };
  const reset = () => { dispatch({ type: "RESET" }); setDrafts({ ...blankDrafts }); setMobileOpen(false); composing.current = false; setResetIndex((value) => value + 1); composer.current?.focus({ preventScroll: true }); };

  return <div className="demo-app">
    <a className="skip-link" href="#chat-main">대화로 바로 가기</a>
    <header className="demo-disclosure"><span className="disclosure-dot" aria-hidden="true" /><strong>공개 체험 데모 · 실제 AI 응답·파일 실행 아님</strong><span className="disclosure-extra">입력과 변경은 이 탭의 메모리에서만 처리됩니다.</span></header>
    <div className="workspace-shell">
      <Sidebar state={state} onSelect={select} mobileOpen={mobileOpen} onClose={closeMenu} />
      <main className="chat-main" id="chat-main" tabIndex={-1}>
        <header className="chat-header"><div className="header-location"><button className="icon-button mobile-only" ref={menuButton} type="button" aria-label="시나리오 메뉴" aria-controls="scenario-sidebar" aria-expanded={mobileOpen} onClick={() => setMobileOpen((open) => !open)}><Icon name="menu" /></button><span className="breadcrumb">가을 업데이트<span>/</span></span><h1>{scenario.label}</h1></div><button className="reset-button" type="button" data-testid="demo-reset" onClick={reset}><Icon name="restore" size={15} /><span>처음부터 다시</span></button></header>
        <div className="chat-toolbar"><Status session={session} /><span className="memory-label"><span className="memory-dot" />브라우저 메모리</span></div>
        <div className="chat-scroll" ref={chatScroll} role="region" aria-label="샘플 대화와 작업 제안" tabIndex={0}>
          <div className="chat-inner">
            <section className="welcome" aria-labelledby="welcome-title"><div className="welcome-mark" aria-hidden="true"><Icon name="leaf" size={26} /></div><p className="eyebrow">생각에서 실행까지, 확인하며</p><h2 id="welcome-title">실행은 신중하게.<br />결과는 분명하게.</h2><p className="welcome-copy">AI가 제안하고, 내가 승인하고.<br />변경의 근거를 확인하는 작업 흐름을 체험하세요.</p><Progress session={session} /></section>
            <section className="scenario-card" aria-labelledby="scenario-title"><div className="scenario-card-top"><span className="reference-icon"><Icon name="file" size={20} /></span><div><p className="eyebrow">이번에 해볼 일</p><h3 id="scenario-title">{scenario.label}</h3></div><span className="outline-tag">샘플</span></div><p>{scenario.note}</p><div className="reference-pill"><Icon name="file" size={13} />brief.txt<span>참고자료 1개 연결</span></div><button className="button primary full-width" type="button" data-testid="demo-propose" disabled={!canPropose} onClick={propose}>{canPropose ? "샘플 제안 만들기" : "변경과 근거에서 다음 단계로"}<Icon name="arrow" size={16} /></button></section>
            <div className="conversation-divider"><span>샘플 대화</span><span>실제 모델은 연결하지 않습니다.</span></div>
            <div className="messages" role="log" aria-label="이 대화의 샘플 메시지" aria-live="off">
              {session.messages.length === 0 ? <article className="message assistant"><span className="message-avatar" aria-hidden="true">A</span><div><div className="message-meta"><strong>AIOS</strong><span>미리 준비된 안내</span></div><p>준비된 자료와 변경 내용을 먼저 보여 드릴게요. 위에서 샘플 제안을 만들면, 오른쪽에서 승인·검증·복구를 직접 선택할 수 있습니다.</p></div></article> : session.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span className="message-avatar" aria-hidden="true">{message.role === "user" ? "나" : message.role === "system" ? <Icon name="shield" size={15} /> : "A"}</span><div><div className="message-meta"><strong>{message.role === "user" ? "나" : message.role === "system" ? "체험 기록" : "AIOS"}</strong><span>{message.role === "user" ? "이 탭에만 남는 입력" : message.role === "system" ? "가상 작업 상태" : "미리 준비된 샘플 응답"}</span></div><p>{message.text}</p></div></article>)}
            </div>
          </div>
        </div>
        <div className="composer-area"><div className="composer"><label className="sr-only" htmlFor="demo-message-input">메시지 입력</label><textarea id="demo-message-input" data-testid="demo-message-input" ref={composer} value={draft} maxLength={MAX_MESSAGE_LENGTH} rows={2} placeholder="무엇을 해볼까요? 메시지를 입력해 보세요." onChange={(event) => setDrafts((current) => ({ ...current, [state.active]: event.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (shouldSend({ key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, repeat: event.repeat, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, composing.current)) { event.preventDefault(); send(); } }} /><div className="composer-bottom"><span className="composer-mode"><Icon name="shield" size={14} />샘플 응답</span><span className="input-length">{draft.length}/{MAX_MESSAGE_LENGTH}</span><button className="send-button" type="button" aria-label="메시지 보내기" data-testid="demo-send" disabled={!draft.trim() || draft.length > MAX_MESSAGE_LENGTH} onClick={send}><Icon name="arrow" size={19} /></button></div></div><div className="composer-help"><span>Enter 전송 · Shift+Enter 줄바꿈</span><span>새로고침하면 모든 체험이 초기화됩니다.</span></div><a className="mobile-evidence-link" href="#work-evidence">변경·승인·검증 영역 보기 <Icon name="arrow" size={14} /></a></div>
      </main>
      <aside className="evidence-sidebar" id="work-evidence" ref={evidence} aria-labelledby="evidence-title" tabIndex={-1}><EvidencePanel key={`${resetIndex}-${session.id}`} session={session} dispatch={dispatch} /><SourceFooter /></aside>
    </div>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{session.announcement}</div>
  </div>;
}
