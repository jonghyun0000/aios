export type ScenarioId = "normal" | "failure" | "conflict";
export type Phase = "ready" | "awaiting_approval" | "rejected" | "applied" | "verified" | "verification_failed" | "manually_edited" | "restore_conflict" | "restored";
export const MAX_MESSAGE_LENGTH = 800;
export const FILE_PATH = "sample/launch.md";
export const REFERENCE_PATH = "sample/brief.txt";
export const BEFORE = "# 가을 업데이트 안내\n\n출시일: 미정\n\n새로운 작업공간을 준비하고 있습니다.\n";
export const AFTER = "# 가을 업데이트 안내\n\n출시일: 2026-10-01\n\n자료를 연결하고, 변경을 승인하고, 결과를 확인하세요.\n문의: help@example.test\n";
export const REFERENCE = "가을 업데이트 · 샘플 브리프\n\n출시일: 2026-10-01\n핵심 안내: 자료 연결 → 변경 승인 → 결과 확인\n문의 주소: help@example.test\n문체: 짧고 명확하게\n\n※ 이 문서와 이메일 주소는 체험용 가상 자료입니다.";
export const MANUAL_NOTE = "\n직접 남긴 메모: 출시 전에 팀과 한 번 더 확인하기.\n";

export const SCENARIOS: ReadonlyArray<{ id: ScenarioId; label: string; description: string; note: string }> = [
  { id: "normal", label: "출시 안내 다듬기", description: "승인부터 복구까지", note: "자료에 맞게 수정한 뒤, 같은 내용인지 확인합니다." },
  { id: "failure", label: "검증 실패 살펴보기", description: "잘못된 결과도 드러나게", note: "가상 실행 중 날짜가 누락되는 결함을 주입합니다." },
  { id: "conflict", label: "복구 충돌 확인하기", description: "내 수정은 덮어쓰지 않게", note: "수동 변경을 만든 뒤 복구가 차단되는지 확인합니다." },
];

export interface Message { id: string; role: "assistant" | "user" | "system"; text: string }
export interface EvidenceCheck { label: string; expected: string; actual: string; passed: boolean }
export interface Proposal { id: string; before: string; after: string; path: string }
export interface Checkpoint { before: string; after: string }
export interface Evidence { checks: EvidenceCheck[]; content: string; passed: boolean }
export interface Audit { id: string; label: string; detail: string; tone: "neutral" | "good" | "warning" }
export interface Session {
  id: ScenarioId; phase: Phase; content: string; proposal: Proposal | null; checkpoint: Checkpoint | null;
  evidence: Evidence | null; messages: Message[]; audits: Audit[]; sequence: number; announcement: string;
}
export interface DemoState { active: ScenarioId; sessions: Record<ScenarioId, Session> }
export type Action =
  | { type: "SELECT"; scenario: ScenarioId }
  | { type: "RESET" }
  | { type: "SEND"; scenario: ScenarioId; text: string }
  | { type: "PROPOSE"; scenario: ScenarioId }
  | { type: "APPROVE" | "REJECT" | "VERIFY" | "MANUAL_EDIT" | "RESTORE"; scenario: ScenarioId; proposalId: string };

function newSession(id: ScenarioId): Session {
  return { id, phase: "ready", content: BEFORE, proposal: null, checkpoint: null, evidence: null, messages: [], audits: [], sequence: 1, announcement: "샘플 자료가 준비됐습니다. 변경 제안부터 시작해 보세요." };
}
export function createInitialState(): DemoState {
  // 새 객체만 만든다. 브라우저 저장소/URL에서 상태를 복원하지 않아 새로고침은 항상 초기화다.
  return { active: "normal", sessions: { normal: newSession("normal"), failure: newSession("failure"), conflict: newSession("conflict") } };
}
function withEvent(session: Session, label: string, detail: string, tone: Audit["tone"] = "neutral"): Session {
  return {
    ...session, sequence: session.sequence + 1, announcement: detail,
    audits: [...session.audits, { id: `event-${session.sequence}`, label, detail, tone }].slice(-20),
    messages: [...session.messages, { id: `system-${session.sequence}`, role: "system" as const, text: detail }].slice(-40),
  };
}
export function verifyContent(content: string, proposedContent: string): Evidence {
  const date = content.split("\n").find((line) => line.startsWith("출시일:"))?.slice(4).trim() ?? "(없음)";
  const contact = content.split("\n").find((line) => line.startsWith("문의:"))?.slice(3).trim() ?? "(없음)";
  const checks = [
    { label: "브리프의 출시일", expected: "2026-10-01", actual: date, passed: date === "2026-10-01" },
    { label: "브리프의 문의 주소", expected: "help@example.test", actual: contact, passed: contact === "help@example.test" },
    { label: "승인한 내용과 파일 일치", expected: "전체 텍스트 일치", actual: content === proposedContent ? "전체 텍스트 일치" : "전체 텍스트 불일치", passed: content === proposedContent },
  ];
  return { checks, content, passed: checks.every((item) => item.passed) };
}
export function isEvidenceCurrent(session: Session): boolean { return session.evidence !== null && session.evidence.content === session.content && session.phase !== "restored"; }

export function demoReducer(state: DemoState, action: Action): DemoState {
  if (action.type === "RESET") return createInitialState();
  if (!Object.hasOwn(state.sessions, action.scenario)) return state;
  if (action.type === "SELECT") return { ...state, active: action.scenario };
  // 작업은 제안이 만들어진 대화에 묶는다. 다른 탭/옛 제안의 승인으로 현재 파일을 바꿀 수 없다.
  if (action.scenario !== state.active) return state;
  const current = state.sessions[action.scenario];
  let next = current;
  if (action.type === "SEND") {
    const text = action.text.trim();
    if (!text || action.text.length > MAX_MESSAGE_LENGTH) return state;
    const response = "입력을 받았습니다. 이곳은 미리 준비된 흐름을 보여 주는 데모라 질문을 실제 AI에 보내지 않습니다. ‘샘플 제안 만들기’로 승인·검증·복구를 직접 살펴보세요. 입력은 이 탭의 메모리에만 남고 새로고침하면 사라집니다.";
    next = { ...current, sequence: current.sequence + 1, announcement: "샘플 응답이 표시되었습니다. 실제 AI 응답이 아닙니다.", messages: [...current.messages, { id: `user-${current.sequence}`, role: "user" as const, text }, { id: `assistant-${current.sequence}`, role: "assistant" as const, text: response }].slice(-40) };
  } else if (action.type === "PROPOSE") {
    if (!["ready", "rejected", "restored"].includes(current.phase)) return state;
    const proposal = { id: `${current.id}-proposal-${current.sequence}`, before: current.content, after: AFTER, path: FILE_PATH };
    next = withEvent({ ...current, phase: "awaiting_approval", proposal, checkpoint: null, evidence: null }, "변경 제안", "샘플 브리프에 맞춘 변경을 제안했습니다. 아직 가상 파일도 수정하지 않았습니다. 변경 전후를 확인한 뒤 승인하거나 거절하세요.");
  } else {
    const proposal = current.proposal;
    if (!proposal || proposal.id !== action.proposalId) return state;
    if (action.type === "APPROVE") {
      if (current.phase !== "awaiting_approval" || current.content !== proposal.before) return state;
      // 실패 시나리오는 가상 실행 결과에 실제 텍스트 결함을 넣는다. 검증을 무조건 실패로 표시하지 않는다.
      const written = current.id === "failure" ? proposal.after.replace("출시일: 2026-10-01", "출시일: 미정") : proposal.after;
      next = withEvent({ ...current, phase: "applied", content: written, checkpoint: { before: proposal.before, after: written } }, "승인 후 가상 수정", current.id === "failure" ? "승인 후 메모리의 가상 파일을 수정했습니다. 이 시나리오는 날짜 누락 오류를 주입했습니다. 검증으로 찾아보세요." : "이번 변경을 승인했고, 메모리의 가상 파일을 수정했습니다. 원본도 복구 지점에 보관했습니다. 아직 검증하지 않았습니다.");
    } else if (action.type === "REJECT") {
      if (current.phase !== "awaiting_approval") return state;
      next = withEvent({ ...current, phase: "rejected" }, "작업 거절", "변경을 거절했습니다. 가상 파일은 원본 그대로이며, 실행한 작업은 없습니다.", "warning");
    } else if (action.type === "VERIFY") {
      if (!["applied", "manually_edited"].includes(current.phase)) return state;
      const evidence = verifyContent(current.content, proposal.after);
      next = withEvent({ ...current, evidence, phase: evidence.passed ? "verified" : "verification_failed" }, "샘플 검증", evidence.passed ? "샘플 텍스트 비교 3개가 모두 일치했습니다. 실제 프로그램 실행이나 모든 요구사항의 정답을 검증한 것은 아닙니다." : "샘플 텍스트 비교가 실패했습니다. 기대한 내용과 실제 가상 파일의 차이를 확인하세요. 실패를 완료로 표시하지 않습니다.", evidence.passed ? "good" : "warning");
    } else if (action.type === "MANUAL_EDIT") {
      if (!["applied", "verified", "verification_failed"].includes(current.phase) || current.content.endsWith(MANUAL_NOTE)) return state;
      next = withEvent({ ...current, phase: "manually_edited", content: current.content + MANUAL_NOTE }, "수동 변경 표본", "가상 파일에 직접 쓴 메모를 추가했습니다. 이전 검증 결과는 이제 현재 파일의 보장이 아닙니다. 복구하면 충돌을 확인할 수 있습니다.", "warning");
    } else if (action.type === "RESTORE") {
      if (!current.checkpoint || !["applied", "verified", "verification_failed", "manually_edited", "restore_conflict"].includes(current.phase)) return state;
      if (current.content !== current.checkpoint.after) {
        if (current.phase === "restore_conflict") return state;
        next = withEvent({ ...current, phase: "restore_conflict" }, "복구 차단", "복구를 차단했습니다. 승인 이후 직접 수정한 내용이 있어 덮어쓰지 않았습니다. 현재 파일과 원본을 비교하거나 처음부터 다시 체험하세요.", "warning");
      } else {
        next = withEvent({ ...current, phase: "restored", content: current.checkpoint.before }, "원본 복구", "가상 파일을 변경 전 원본으로 복구했습니다. 이전 검증 통과를 복구된 파일의 검증 결과로 사용하지 않습니다.", "good");
      }
    }
  }
  return next === current ? state : { ...state, sessions: { ...state.sessions, [action.scenario]: next } };
}

export const PHASE_LABELS: Record<Phase, string> = {
  ready: "샘플 준비", awaiting_approval: "승인 대기", rejected: "거절됨 · 변경 없음", applied: "가상 수정 · 미검증", verified: "샘플 검증 통과", verification_failed: "샘플 검증 실패", manually_edited: "수동 변경 · 재검증 필요", restore_conflict: "복구 차단 · 현재 내용 보존", restored: "원본 복구 · 이전 검증 무효",
};
