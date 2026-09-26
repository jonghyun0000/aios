import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, messageText, messageToolCalls, type MessageRow,
} from "../lib/api.js";
import { streamChat, type ChatEvent } from "../lib/stream.js";
import { AsyncBoundary } from "../components/Async.js";
import { useRouter } from "../lib/router.js";
import { useSessions } from "../lib/sessions.js";
import { shouldSendOnEnter } from "../lib/chat-input.js";
import { presentWorkspaceContext, type WorkspacePresentation } from "../lib/workspace-context.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import { ExecutionPanel } from "../components/ExecutionPanel.js";
import { takeDataAnalysisDraft } from "../lib/data-analysis-draft.js";
import type { ChatMode, TimingPhase } from "../../../../packages/shared/src/types.js";

interface ToolTrace { id: string; name: string; ok?: boolean; summary?: string }

interface LiveTurn {
  text: string;
  thinking: string;
  tools: ToolTrace[];
  routed?: { provider: string; model: string };
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

const EMPTY_TURN: LiveTurn = { text: "", thinking: "", tools: [] };
const PATH_LABEL = { fast: "빠른 응답", thorough: "깊이 생각", calculator: "정확 계산" };
const PHASE_LABEL: Record<TimingPhase, string> = { save_input: "입력 저장", context: "기억·자료 검색", client_queue: "앱 대기열", model_load: "모델 적재", prompt_eval: "입력 처리", generation: "추론·답변 생성", server_total: "모델 서버 전체", first_text: "첫 글자까지", tools: "도구 실행", save_output: "답변 저장", total: "앱 전체" };

function useMessages(sessionId: string | null) {
  const [state, setState] = useState<{ id: string | null; data: { messages: MessageRow[] } | null; loading: boolean; error: string | null }>({ id: null, data: null, loading: false, error: null });
  const current = useRef(sessionId);
  current.current = sessionId;
  const version = useRef(0);
  const reload = useCallback(async (id: string | null) => {
    if (current.current !== id) return false;
    const request = ++version.current;
    setState((old) => ({ id, data: old.id === id ? old.data : null, loading: true, error: null }));
    try {
      const data = id ? await api<{ messages: MessageRow[] }>(`/v1/sessions/${id}/messages`, { signal: AbortSignal.timeout(12_000) }) : { messages: [] };
      if (version.current === request && current.current === id) setState({ id, data, loading: false, error: null });
      return version.current === request && current.current === id;
    } catch (err) {
      if (version.current === request && current.current === id) setState((old) => ({ ...old, loading: false, error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }, []);
  useEffect(() => { const counter = version; void reload(sessionId); return () => { counter.current++; }; }, [sessionId, reload]);
  return { ...state, data: state.id === sessionId ? state.data : null, loading: state.id !== sessionId || state.loading, reload };
}

export function ChatPage({ sessionId }: { sessionId: string | null }) {
  const { navigate } = useRouter();
  const { refresh: refreshSessions, setBusy } = useSessions();
  const history = useMessages(sessionId);

  const [input, setInput] = useState("");
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const activeSessionRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [useMemory, setUseMemory] = useState(true);
  const [verificationCommand, setVerificationCommand] = useState("");
  const [executionRevision, setExecutionRevision] = useState(0);
  const [mode, setMode] = useState<ChatMode>("auto");
  const [strategy, setStrategy] = useState<{ path: keyof typeof PATH_LABEL; reason: string } | null>(null);
  const [timings, setTimings] = useState<Partial<Record<TimingPhase, number>>>({});
  const [contextNotice, setContextNotice] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceStarting, setWorkspaceStarting] = useState(false);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspacePresentation | null>(null);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followScrollRef = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 스트림 도중 도착한 에러를 붙잡아 둔다.
   * 이게 없으면 턴이 끝날 때 live 상태를 비우면서 에러 메시지까지 같이 사라져,
   * 사용자 눈에는 "보냈는데 아무 일도 안 일어남"으로 보인다. 실제로 그랬다.
   */
  const streamErrorRef = useRef<string | null>(null);
  /**
   * 스트림이 끝난 뒤 남길 한 줄. live 를 비우는 순간 상태 영역이 비면
   * 스크린리더 사용자는 '끝났다'는 사실을 듣지 못한다.
   */
  const [lastAnnouncement, setLastAnnouncement] = useState("");

  // 새 내용이 오면 아래로 따라간다. 사용자가 위로 스크롤해 과거를 읽는 중이면 방해하지 않는다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [live, history.data]);

  useEffect(() => () => { abortRef.current?.abort(); setBusy(false); }, [setBusy]);
  // 공공통계 화면의 선택값은 URL에 넣지 않는다. URL은 브라우저 이력·공유 화면에 남기 쉽고,
  // 초안도 모델로 자동 전송하지 않아 사용자가 수치·질문을 먼저 검토할 수 있게 한다.
  useEffect(() => {
    if (sessionId) return;
    const draft = takeDataAnalysisDraft();
    if (!draft) return;
    setInput(draft.prompt);
    setContextNotice(`‘${draft.label}’ 통계 분석 초안을 넣었습니다. 확인·수정한 뒤 전송하세요.`);
    queueMicrotask(() => textareaRef.current?.focus());
  }, [sessionId]);
  useEffect(() => {
    followScrollRef.current = true;
    if (!sendingRef.current) { setStrategy(null); setTimings({}); setContextNotice(""); setWorkspaceContext(null); }
    if (activeSessionRef.current && activeSessionRef.current !== sessionId) abortRef.current?.abort();
  }, [sessionId]);
  useEffect(() => {
    if (!sending) { textareaRef.current?.focus(); return; }
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  const createSession = useCallback(async (title = "새 대화", signal?: AbortSignal) => {
    const { id } = await api<{ id: string }>("/v1/sessions", { method: "POST", body: JSON.stringify({ title }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
    signal?.throwIfAborted();
    activeSessionRef.current = id;
    refreshSessions();
    navigate(`/chat/${id}`);
    return id;
  }, [navigate, refreshSessions]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setBusy(true);
    followScrollRef.current = true;
    setSendError(null);
    streamErrorRef.current = null;
    setLastAnnouncement("");
    setLive({ ...EMPTY_TURN });
    setStrategy(null); setTimings({}); setContextNotice("");
    setWorkspaceContext(null);
    const controller = new AbortController();
    abortRef.current = controller;
    activeSessionRef.current = sessionId;

    const apply = (e: ChatEvent) => {
      if (controller.signal.aborted) return;
      if (e.type === "execution_update") { setExecutionRevision((old) => old + 1); return; }
      if (e.type === "incomplete") { setContextNotice(e.reason); return; }
      if (e.type === "workspace_context") { setWorkspaceContext(presentWorkspaceContext(e)); return; }
      if (e.type === "strategy") { setStrategy({ path: e.path, reason: e.reason }); return; }
      if (e.type === "timing") { setTimings((old) => ({ ...old, [e.phase]: (old[e.phase] ?? 0) + e.durationMs })); return; }
      if (e.type === "context_trimmed") { setContextNotice("입력 한도로 오래된 대화·참고자료 일부를 제외했습니다. 필요한 내용은 다시 알려주세요."); return; }
      // 부수 효과를 상태 updater 밖에 둬야 React가 실행을 미뤄도 오류를 잃지 않는다.
      if (e.type === "error") streamErrorRef.current = `${e.code}: ${e.message}`;
      setLive((prev) => {
        const t = prev ?? { ...EMPTY_TURN };
        switch (e.type) {
          case "routed": return { ...t, routed: { provider: e.provider, model: e.model } };
          case "text_delta": return { ...t, text: t.text + e.text };
          case "thinking_delta": return { ...t, thinking: t.thinking + e.text };
          case "tool_call":
          case "tool_start":
            return t.tools.some((x) => x.id === e.call.id)
              ? t
              : { ...t, tools: [...t.tools, { id: e.call.id, name: e.call.name }] };
          case "tool_result":
            return { ...t, tools: t.tools.map((x) => (x.id === e.id ? { ...x, ok: e.ok, summary: e.summary } : x)) };
          case "usage":
            return { ...t, usage: { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens } };
          case "error": {
            const detail = `${e.code}: ${e.message}`;
            return { ...t, error: detail };
          }
          default: return t;
        }
      });
    };

    let target = sessionId;
    try {
      target ??= await createSession(content.slice(0, 60), controller.signal);
      controller.signal.throwIfAborted();
      setInput("");
      setPendingMessage(content);
      await streamChat({ sessionId: target, content, toolsEnabled, verificationCommand, mode, useMemory, signal: controller.signal, onEvent: apply });
    } catch (err) {
      if (controller.signal.aborted) return; // 사용자가 중단한 것은 에러가 아니다
      const detail = err instanceof Error ? err.message : String(err);
      streamErrorRef.current = detail;
      setSendError(detail);
      setInput(content);
    } finally {
      abortRef.current = null;
      // 스트림 도중 온 에러는 live를 비우기 전에 영구 표시 영역으로 옮긴다.
      if (streamErrorRef.current) setSendError(streamErrorRef.current);
      setLastAnnouncement(
        streamErrorRef.current
          ? "응답이 실패했습니다."
          : controller.signal.aborted
            ? "응답을 중단했습니다."
            : "응답이 완료되었습니다.",
      );
      // 스트림이 끝나면 서버가 저장한 확정본을 다시 읽는다.
      // 화면의 임시 상태를 진실로 삼으면 새로고침 시 내용이 달라진다.
      const loaded = await history.reload(target);
      refreshSessions();
      // 저장본 재조회가 실패해도 방금 받은 답을 지우지 않는다.
      if (loaded || controller.signal.aborted) { setLive(null); setPendingMessage(null); }
      sendingRef.current = false;
      setSending(false);
      setBusy(false);
      setExecutionRevision((old) => old + 1);
    }
  }, [input, sessionId, createSession, history, refreshSessions, setBusy, toolsEnabled, verificationCommand, mode, useMemory]);

  /*
   * 스크린리더에 알릴 상태 문구.
   *
   * 스트리밍 텍스트에 aria-live 를 직접 걸면 안 된다. 글자가 늘어날 때마다
   * **문장 전체를 처음부터 다시 읽는다** — 침묵보다 나쁘다.
   * 그래서 본문이 아니라 '상태 변화'만 알린다: 생성 시작 / 도구 사용 / 완료.
   * 답변 내용은 사용자가 원할 때 직접 탐색해 읽는다.
   */
  const liveStatus = live && sending
    ? live.error
      ? `오류: ${live.error}`
      : live.tools.length > 0 && live.tools.some((t) => t.ok === undefined)
        ? `도구 ${live.tools[live.tools.length - 1]!.name} 실행 중`
        : live.text
          ? "응답 생성 중"
          : "요청을 보냈습니다. 응답을 기다리는 중"
    : lastAnnouncement;

  return (
    <div className="chat-page">
      {/* 화면에는 보이지 않지만 스크린리더가 읽는다 */}
      <div className="sr-only" role="status" aria-live="polite">{liveStatus}</div>
      <div className="row-between">
        <div>
          <h1>채팅</h1>
          <p className="page-sub">생각을 정리하고, 필요한 작업을 이어가세요.</p>
        </div>
        <div className="workspace-actions"><button data-workspace-trigger disabled={sending || workspaceStarting} onClick={() => {
          if (sessionId) { setWorkspaceOpen(true); return; }
          setWorkspaceStarting(true); setBusy(true);
          const controller = new AbortController(); abortRef.current = controller;
          void createSession("새 대화", controller.signal).then(() => setWorkspaceOpen(true)).catch((err: Error) => { if (!controller.signal.aborted) setSendError(err.message); }).finally(() => { abortRef.current = null; setWorkspaceStarting(false); setBusy(false); });
        }}>자료·프로젝트</button><span className="badge">{mode === "auto" ? "자동 선택" : PATH_LABEL[mode]}</span></div>
      </div>
      {workspaceOpen && sessionId && <WorkspacePanel key={sessionId} sessionId={sessionId} onClose={() => setWorkspaceOpen(false)} />}

      <div className="chat-layout">
        <section className="chat-main">
          {!sessionId ? (
            <div className="chat-welcome">
              <div><div className="welcome-symbol" aria-hidden>✦</div><h2>무엇을 도와드릴까요?</h2>
              <p className="muted">메시지를 보내면 새 대화가 시작됩니다.<br />이전 대화는 대화 내역에서 이어갈 수 있습니다.</p></div>
            </div>
          ) : (
            <div className="messages" role="region" aria-label="대화 메시지" tabIndex={0} ref={scrollRef} onScroll={() => {
              const el = scrollRef.current;
              if (el) followScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}>
              <AsyncBoundary loading={history.loading && !history.data} error={history.error}>
                {history.data?.messages.map((m) => {
                  const calls = messageToolCalls(m.content);
                  return (
                    <div className="msg" key={m.id}>
                      <div className="msg-role">
                        {m.role === "user" ? "나" : m.role === "assistant" ? "AI" : m.role === "tool" ? "도구" : "sys"}
                      </div>
                      <div className="msg-body">
                        {messageText(m.content)}
                        {calls.length > 0 && (
                          <div style={{ marginTop: 6 }}>
                            {calls.map((c) => (
                              <span className="tool-chip" key={c.id}>⚙ {c.name}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </AsyncBoundary>

              {pendingMessage && !history.data?.messages.some((m) => m.role === "user" && messageText(m.content) === pendingMessage) && (
                <div className="msg"><div className="msg-role">나</div><div className="msg-body">{pendingMessage}</div></div>
              )}
              {live && (
                <div className="msg">
                  <div className="msg-role">AI</div>
                  <div className="msg-body">
                    {live.routed && (
                      <div className="small muted" style={{ marginBottom: 6 }}>
                        {live.routed.provider} · <code>{live.routed.model}</code>
                      </div>
                    )}
                    {live.thinking && <div className="thinking">{live.thinking}</div>}
                    {live.tools.length > 0 && (
                      <div style={{ margin: "8px 0" }}>
                        {live.tools.map((t) => (
                          <span key={t.id} className="tool-chip" title={t.summary}>
                            {t.ok === undefined ? "◌" : t.ok ? "✓" : "✕"} {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {live.text || (!live.thinking && !live.error && <span className="muted">생성 중…</span>)}
                    {live.error && <div className="alert" role="alert" style={{ marginTop: 8 }}>{live.error}</div>}
                    {live.usage && (
                      <div className="small muted" style={{ marginTop: 6 }}>
                        입력 {live.usage.inputTokens} · 출력 {live.usage.outputTokens} 토큰
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {sendError && (
            <div className="alert" role="alert" style={{ marginTop: 12 }}>
              <div>{sendError}</div>
              {/* 프로바이더 계정 문제는 코드 버그가 아니다. 사용자가 무엇을 해야 하는지 알려준다. */}
              {/credit balance|quota|billing|insufficient/i.test(sendError) && (
                <div className="small" style={{ marginTop: 6 }}>
                  AI 프로바이더 계정의 크레딧이 부족합니다. 서버의 프로바이더 키 결제 상태를 확인하세요.
                  이것은 AIOS 자체의 오류가 아닙니다.
                </div>
              )}
            </div>
          )}

          {sessionId && <ExecutionPanel key={sessionId} sessionId={sessionId} revision={executionRevision} sending={sending} />}
          <div className="chat-options">
            <label className="mode-control">응답 모드
              <select aria-label="응답 모드" value={mode} disabled={sending} onChange={(e) => setMode(e.target.value as ChatMode)}>
                <option value="auto">자동 선택</option>
                <option value="fast">빠른 응답</option><option value="thorough">깊이 생각</option>
              </select>
            </label>
          <label className="small tools-option" title="공공통계 조회 · 작업 폴더 파일 편집 · 샌드박스 실행">
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={toolsEnabled} disabled={sending} onChange={(e) => setToolsEnabled(e.target.checked)} />{" "}
            도구 사용 허용
          </label>
          </div>
          {toolsEnabled && <label className="small verification-command">검증 명령 (선택)
            <input aria-label="검증 명령" value={verificationCommand} maxLength={4000} disabled={sending} placeholder="예: node --test test.js" onChange={(e) => setVerificationCommand(e.target.value)} />
            <span className="muted">파일 수정·명령 실행은 건별 승인이 필요합니다. 검증 명령이 없으면 동작 미검증으로 표시합니다.</span>
          </label>}
          <div className="small muted mode-hint">{mode === "auto" ? "질문에 따라 빠른 응답·정확 계산·깊이 생각을 선택합니다. 직접 모드를 바꿀 수도 있습니다." : mode === "fast" ? "장기기억 검색을 생략합니다. 계산·복잡한 코드는 ‘자동 선택’을 권장합니다." : "긴 추론을 사용하며 기억이 켜져 있으면 장기기억도 검색합니다. 응답 시간이 더 걸릴 수 있습니다."}</div>
          <details className="small context-controls">
            <summary>기억·참고자료 사용 범위</summary>
            <label className="memory-option"><input type="checkbox" checked={useMemory} disabled={sending} onChange={(e) => setUseMemory(e.target.checked)} />이전 대화와 답변 선호 사용</label>
            <p className="muted">끄면 다음 요청부터 이전 대화·답변 선호를 불러오지 않습니다. 채팅 저장을 끄거나 기존 대화를 삭제하는 기능은 아닙니다. 다시 켜면 기억을 사용합니다.</p>
            <p className="muted">이 대화의 최근 본문 최대 100개와 사용자 요청 최대 500개에서 언어·형식·길이 선호를 확인합니다. 입력 한도로 일부가 제외될 수 있으며, 이번에 명시한 요청이 우선입니다.</p>
            <button disabled={sending || workspaceStarting || !!input.trim()} onClick={() => {
              setInput("이 대화의 답변 선호를 초기화해줘.");
              textareaRef.current?.focus();
            }}>답변 선호 초기화 문장 넣기</button>
            <p className="muted">빈 입력란에 문장만 넣습니다. 이 문장을 단독으로 전송하면 답변 선호를 초기화하며 기존 대화는 보존합니다. 초안이 있다면 먼저 전송하거나 별도로 보관한 뒤 입력란을 비워주세요.</p>
          </details>
          {strategy && <div className="small mode-hint" data-testid="chat-strategy">{PATH_LABEL[strategy.path]} · {strategy.reason}</div>}
          {contextNotice && <div className="small mode-hint" role="status">{contextNotice}</div>}
          {workspaceContext && <div className="small mode-hint workspace-context" data-testid="workspace-context">
            <div className="muted">{workspaceContext.summary}</div>
            {workspaceContext.memoryNotice && <div data-testid="workspace-memory">{workspaceContext.memoryNotice}</div>}
            {workspaceContext.sources.length > 0 && <details data-testid="workspace-sources"><summary>답변에 전달된 참고 구간 {workspaceContext.sources.length}개</summary><ul>{workspaceContext.sources.map((source) => <li key={source.id}>{source.label}</li>)}</ul><div className="muted">전달한 범위이며, 답변의 정확성이나 자료 전체 검증을 보장하지 않습니다.</div></details>}
          </div>}
          {Object.keys(timings).length > 0 && <details className="small muted mode-hint" data-testid="chat-timings">
            <summary>이번 응답 시간{timings.total !== undefined ? ` · ${(timings.total / 1000).toFixed(2)}초` : ""}</summary>
            <div>{Object.entries(timings).map(([phase, ms]) => <span key={phase} style={{ display: "inline-block", marginRight: 14 }}>{PHASE_LABEL[phase as TimingPhase]} {(ms / 1000).toFixed(2)}초</span>)}</div>
            <div>앱 전체는 응답 엔진 기준이며 권한 확인·저장 자료 불러오기·브라우저 왕복은 제외합니다. 첫 글자·모델 서버 전체는 다른 구간을 포함하므로 합산하지 않습니다. 모델 시간은 제공되는 경우만 표시합니다.</div>
          </details>}
          {sending && <div className="small muted generation-status" role="status">{liveStatus} <span aria-hidden>· {elapsed}초</span></div>}
          <div className="composer">
            <textarea
              aria-label="메시지 입력"
              ref={textareaRef}
              value={input}
              disabled={sending || workspaceStarting}
              placeholder="메시지를 입력하세요…"
              aria-describedby="composer-help"
              onChange={(e) => setInput(e.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(e) => {
                if (shouldSendOnEnter(e.nativeEvent, composingRef.current)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {sending ? (
              <button className="danger" onClick={() => abortRef.current?.abort()}>중단</button>
            ) : (
              <button className="primary" onClick={() => void send()} disabled={!input.trim() || workspaceStarting}>전송</button>
            )}
          </div>
          <div className="composer-help small muted" id="composer-help">Enter로 전송 · Shift+Enter로 줄바꿈</div>
        </section>
      </div>
    </div>
  );
}
