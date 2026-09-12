export interface WorkspaceContext {
  historyCount: number;
  files: string[];
  excerpted: boolean;
  memory?: { enabled: boolean; historyLimit: 100; preferenceScanLimit: 500; scannedUserMessages: number; restoredPreferences: Array<{ kind: "language" | "format" | "length"; value: string }> };
  sources?: Array<{ id: string; fileName: string; startLine: number; endLine: number }>;
  referenceMode?: "none" | "matched" | "overview";
}
export interface WorkspacePresentation { summary: string; memoryNotice: string | null; sources: Array<{ id: string; label: string }> }

const preferenceLabels: Record<string, string> = { "language:ko": "한국어", "language:en": "영어", "format:bullets": "목록", "format:plain": "일반 문장", "length:concise": "간결하게", "length:detailed": "자세하게" };
const count = (value: unknown, max: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
export function presentWorkspaceContext(context: WorkspaceContext): WorkspacePresentation {
  const history = count(context.historyCount, 100);
  const files = Array.isArray(context.files) ? context.files.length : 0;
  const summary = `저장된 대화 ${history}개 전달${history === 100 ? " (최근 100개 한도)" : ""}${files ? ` · 연결된 참고 파일 ${files}개` : ""}${context.referenceMode === "none" ? " · 답변에 전달된 자료 없음" : context.referenceMode === "overview" ? " · 자료 개요 전달" : context.excerpted ? " · 관련 구간 발췌 전달" : ""}`;
  const memory = context.memory;
  let memoryNotice: string | null = null;
  if (memory?.enabled === false) memoryNotice = "이번 요청은 이전 대화·답변 선호 기억 끔 · 채팅 저장은 유지됩니다.";
  else if (memory?.enabled === true) {
    const restored = Array.isArray(memory.restoredPreferences) ? [...new Set(memory.restoredPreferences.flatMap((item) => {
      if (!item || typeof item.kind !== "string" || typeof item.value !== "string") return [];
      const key = `${item.kind}:${item.value}`;
      return Object.hasOwn(preferenceLabels, key) ? [preferenceLabels[key]!] : [];
    }))] : [];
    memoryNotice = `이전 사용자 요청에서 답변 선호 ${restored.length}개 복원${restored.length ? ` (${restored.join(" · ")})` : ""} · 사용자 메시지 ${count(memory.scannedUserMessages, 500)}개 검사 (최근 최대 500개). 이번에 명시한 요청이 우선입니다.`;
  }
  const sources = Array.isArray(context.sources) ? context.sources.slice(0, 8).flatMap((source, index) => {
    if (!source || typeof source.id !== "string" || typeof source.fileName !== "string" || !source.fileName.trim() || !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || source.endLine > 10_000_000) return [];
    return [{ id: `${source.id.slice(0, 100)}-${index}`, label: `${source.fileName.slice(0, 300)} · ${source.startLine}–${source.endLine}행` }];
  }) : [];
  return { summary, memoryNotice, sources };
}
