import type { MessageRow } from "./api.js";

/** 서버가 답변과 함께 저장한 근거(messages.content.evidence). 화면에 쓰기 전에 모양을 다시 확인한다. */
export interface EvidenceSource { id: string; fileId: string; fileName: string; startLine: number; endLine: number; excerpt: string }
export interface MessageEvidencePresentation {
  sources: Array<EvidenceSource & { label: string }>;
  /** 연결돼 있었지만 이 답변에 구간이 전달되지 않은 파일 */
  undelivered: string[];
  summary: string;
  notes: string[];
}
export interface EvidenceView {
  source: Omit<EvidenceSource, "excerpt">;
  excerpt: string;
  status: "attached" | "detached" | "missing";
  match: boolean | null;
  partial: boolean;
  newerSameName: boolean;
  context: { lines: Array<{ number: number; text: string; cited: boolean }>; truncated: boolean } | null;
}

const isLine = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_000_000;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

export function presentMessageEvidence(content: MessageRow["content"]): MessageEvidencePresentation | null {
  if (!content || typeof content !== "object") return null;
  const raw = content.evidence as { version?: unknown; referenceMode?: unknown; excerpted?: unknown; files?: unknown; sources?: unknown } | undefined;
  if (!raw || raw.version !== 1) return null;
  const files = Array.isArray(raw.files) ? raw.files.flatMap((file: { id?: unknown; name?: unknown }) => isText(file?.id, 100) && isText(file?.name, 300) ? [{ id: file.id, name: file.name }] : []) : [];
  const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 8).flatMap((source: Partial<EvidenceSource>) => {
    if (!source || !/^R[1-9][0-9]{0,2}$/.test(String(source.id)) || !isText(source.fileId, 100) || !isText(source.fileName, 300)
      || !isLine(source.startLine) || !isLine(source.endLine) || source.endLine! < source.startLine! || typeof source.excerpt !== "string" || source.excerpt.length > 4000) return [];
    const s = source as EvidenceSource;
    return [{ ...s, label: `${s.fileName} · ${s.startLine === s.endLine ? `${s.startLine}행` : `${s.startLine}–${s.endLine}행`}` }];
  }) : [];
  if (!files.length && !sources.length) return null;
  const deliveredIds = new Set(sources.map((source) => source.fileId));
  const deliveredFiles = files.filter((file) => deliveredIds.has(file.id)).length;
  const undelivered = files.filter((file) => !deliveredIds.has(file.id)).map((file) => file.name);
  const notes: string[] = [];
  if (raw.referenceMode === "overview") notes.push("질문과 일치하는 내용을 찾지 못해 파일 앞부분 개요만 전달했습니다.");
  if (raw.excerpted === true) notes.push("파일 전체가 아니라 일부 구간만 전달했습니다.");
  const summary = sources.length
    ? `근거: 연결 파일 ${files.length}개 중 ${deliveredFiles}개에서 ${sources.length}개 구간을 모델에 전달`
    : `연결 파일 ${files.length}개가 있었지만 이 답변에는 전달된 구간이 없습니다`;
  return { sources, undelivered, summary, notes };
}

/** 전달 원문을 행 번호와 함께 나눈다. 구간 선택기는 각 줄 뒤에 줄바꿈을 붙이므로 마지막 빈 조각은 버린다. */
export function numberedExcerpt(excerpt: string, startLine: number): Array<{ number: number; text: string }> {
  const lines = excerpt.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map((text, i) => ({ number: startLine + i, text }));
}

export function evidenceStatusMessages(view: EvidenceView): { tone: "ok" | "warn" | "err"; text: string }[] {
  const out: { tone: "ok" | "warn" | "err"; text: string }[] = [];
  if (view.status === "attached" && view.match === true) out.push({ tone: "ok", text: "현재 연결된 파일의 해당 행과 전달 원문이 일치합니다." });
  if (view.status === "attached" && view.match === false) out.push({ tone: "err", text: "전달 원문이 현재 파일의 해당 행과 다릅니다. 이 근거를 그대로 믿지 마세요." });
  if (view.status === "detached") out.push({ tone: "warn", text: "이 파일은 답변 뒤에 연결이 해제됐습니다. 답변 때 전달한 원문만 보여 줍니다." });
  if (view.status === "missing") out.push({ tone: "err", text: "파일을 찾을 수 없습니다. 답변 때 전달한 원문만 보여 줍니다." });
  if (view.newerSameName) out.push({ tone: "warn", text: "답변 뒤에 같은 이름의 새 파일이 연결됐습니다. 이 답변은 이전 사본을 기준으로 했습니다." });
  if (view.partial) out.push({ tone: "warn", text: "긴 줄의 일부(최대 1000자)만 전달했습니다." });
  return out;
}
