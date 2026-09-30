import { describe, expect, it } from "vitest";
import type { MessageRow } from "../lib/api.js";
import { answerMarkdown, conversationMarkdown, exportFileName, fence } from "../lib/answer-export.js";

const FILE = "10000000-0000-4000-8000-000000000003";
const msgs: MessageRow[] = [
  { id: "u1", role: "user", content: { text: "첫 질문" }, created_at: "2026-09-30T01:00:00Z" },
  { id: "a1", role: "assistant", content: { text: "첫 답" }, created_at: "2026-09-30T01:00:05Z" },
  { id: "t1", role: "tool", content: { text: "도구 출력" }, created_at: "2026-09-30T01:00:06Z" },
  { id: "u2", role: "user", content: { text: "출시일은?" }, created_at: "2026-09-30T01:01:00Z" },
  { id: "a2", role: "assistant", created_at: "2026-09-30T01:01:09Z", content: { text: "2026-11-03 입니다 (40행).", evidence: {
    version: 1, referenceMode: "matched", excerpted: false, files: [{ id: FILE, name: "제품계획.md" }],
    sources: [{ id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 40, endLine: 40, excerpt: "출시일: 2026-11-03\n" }] } } },
];

describe("답변 내보내기", () => {
  it("질문·답변·시각·근거·보증 아님 안내를 담는다", () => {
    const md = answerMarkdown(msgs, "a2");
    expect(md).toContain("## 질문\n\n```\n출시일은?\n```");
    expect(md).toContain("## 답변\n\n```\n2026-11-03 입니다 (40행).\n```");
    expect(md).toContain("2026. 9. 30."); expect(md).toContain("(KST)");
    expect(md).toContain("**R1 · 제품계획.md · 40행**"); expect(md).toContain("출시일: 2026-11-03");
    expect(md).toContain("정확하다는 보증이 아닙니다");
    expect(md).not.toContain("첫 질문");
  });
  it("근거 없는 옛 답변은 근거 절이 없다", () => expect(answerMarkdown(msgs, "a1")).not.toContain("#### 근거"));
  it("AI 답변이 아니면 거부한다", () => { expect(() => answerMarkdown(msgs, "u1")).toThrow(); expect(() => answerMarkdown(msgs, "없음")).toThrow(); });
  it("대화 전체는 사용자·AI 메시지만 순서대로", () => {
    const md = conversationMarkdown("출시 계획", msgs, new Date("2026-09-30T02:00:00Z"));
    expect(md.startsWith("# 출시 계획\n")).toBe(true); expect(md).toContain("메시지 4개");
    expect(md.indexOf("첫 질문")).toBeLessThan(md.indexOf("출시일은?")); expect(md).not.toContain("도구 출력");
    expect(md).toContain("#### 근거");
  });
});

describe("코드 블록·파일 이름", () => {
  it("내용의 백틱보다 긴 울타리를 쓴다", () => {
    expect(fence("a ``` b")).toBe("````\na ``` b\n````");
    expect(fence("x ````` y").startsWith("``````\n")).toBe(true);
    expect(fence("끝 줄바꿈\n")).toBe("```\n끝 줄바꿈\n```");
  });
  it("경로·예약 문자를 빼고 자른다", () => {
    const now = new Date("2026-09-30T01:02:03Z");
    expect(exportFileName("../비밀/계획:초안?", "대화", now)).toBe("비밀 계획 초안-대화-202609300102.md");
    expect(exportFileName("   ", "답변", now)).toBe("대화-답변-202609300102.md");
    expect(exportFileName("a\u0007b\nc", "답변", now)).toBe("a b c-답변-202609300102.md");
    expect(exportFileName("가".repeat(100), "답변", now).startsWith("가".repeat(60) + "-")).toBe(true);
  });
});
