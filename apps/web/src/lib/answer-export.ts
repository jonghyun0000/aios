import { messageText, type MessageRow } from "./api.js";
import { presentMessageEvidence } from "./evidence.js";

/**
 * 답변·대화를 Markdown 으로 만든다(docs/45). 이미 받은 메시지로만 만들고 서버로 보내지 않는다.
 * 원문은 가공하지 않고 코드 블록에 넣는다 — 모델 답변의 Markdown 을 다시 해석하면 표·목록이 섞여
 * 원래 답변과 다른 문서가 될 수 있기 때문이다. 대신 복사한 뒤 읽을 수 있게 제목·시각·근거를 붙인다.
 */
const EVIDENCE_NOTE = "전달된 구간은 답변이 정확하다는 보증이 아닙니다. 값과 행 번호를 원문과 비교하세요.";

/** 내용 안의 가장 긴 백틱 연속보다 긴 울타리를 써서 코드 블록이 중간에 닫히지 않게 한다. */
export function fence(text: string, info = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}${info}\n${text.replace(/\n$/, "")}\n${bar}`;
}

const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "시각 미상" : d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " (KST)"; };

function evidenceSection(message: MessageRow): string[] {
  const evidence = presentMessageEvidence(message.content);
  if (!evidence) return [];
  const out = ["", "#### 근거", "", `${evidence.summary}${evidence.undelivered.length ? ` · 전달되지 않은 파일: ${evidence.undelivered.join(", ")}` : ""}`];
  for (const note of evidence.notes) out.push(`- ${note}`);
  for (const source of evidence.sources) out.push("", `**${source.id} · ${source.label}**`, "", fence(source.excerpt));
  out.push("", `> ${EVIDENCE_NOTE}`);
  return out;
}

/** 답변 하나: 바로 앞 사용자 메시지를 질문으로 함께 적는다. */
export function answerMarkdown(messages: MessageRow[], messageId: string): string {
  const index = messages.findIndex((m) => m.id === messageId);
  const answer = messages[index];
  if (!answer || answer.role !== "assistant") throw new Error("내보낼 AI 답변을 찾지 못했습니다.");
  const question = [...messages.slice(0, index)].reverse().find((m) => m.role === "user");
  return [
    "# AIOS 답변",
    "",
    `- 작성: ${when(answer.created_at)}`,
    "",
    "## 질문",
    "",
    question ? fence(messageText(question.content)) : "(질문 기록 없음)",
    "",
    "## 답변",
    "",
    fence(messageText(answer.content)),
    ...evidenceSection(answer),
    "",
  ].join("\n");
}

/** 대화 전체: 사용자·AI 메시지를 순서대로. 도구·시스템 메시지는 제외한다(실행 기록은 별도 화면). */
export function conversationMarkdown(title: string, messages: MessageRow[], exportedAt = new Date()): string {
  const out = [`# ${title.replace(/\s+/g, " ").trim() || "대화"}`, "", `- 내보낸 시각: ${when(exportedAt.toISOString())}`, `- 메시지 ${messages.filter((m) => m.role === "user" || m.role === "assistant").length}개`];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push("", `## ${m.role === "user" ? "나" : "AI"} · ${when(m.created_at)}`, "", fence(messageText(m.content)));
    if (m.role === "assistant") out.push(...evidenceSection(m));
  }
  return out.join("\n") + "\n";
}

/** 파일 이름: 경로·제어·예약 문자를 빼고 60자로 자른다. */
export function exportFileName(title: string, suffix: string, now = new Date()): string {
  // 제어 문자는 정규식 대신 문자 코드로 걸러낸다(no-control-regex).
  const visible = [...title.normalize("NFC")].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");
  const base = visible.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60).trim() || "대화";
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${base}-${suffix}-${stamp}.md`;
}

/** 브라우저에서 파일로 저장한다. 실패는 호출자에게 던진다. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  try { const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
