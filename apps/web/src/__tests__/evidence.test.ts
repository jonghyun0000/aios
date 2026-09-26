import { describe, expect, it } from "vitest";
import { evidenceStatusMessages, numberedExcerpt, presentMessageEvidence, type EvidenceView } from "../lib/evidence.js";

const FILE = "10000000-0000-4000-8000-000000000003";
const evidence = {
  version: 1, referenceMode: "matched", excerpted: true,
  files: [{ id: FILE, name: "제품계획.md" }, { id: "other", name: "무관.md" }],
  sources: [{ id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 40, endLine: 41, excerpt: "출시일: 2026-11-03\n담당: 김하늘\n" }],
};

describe("답변 근거 표시", () => {
  it("전달 구간·전달되지 않은 파일·일부 전달을 알린다", () => {
    const view = presentMessageEvidence({ text: "답", evidence })!;
    expect(view.summary).toBe("근거: 연결 파일 2개 중 1개에서 1개 구간을 모델에 전달");
    expect(view.undelivered).toEqual(["무관.md"]);
    expect(view.notes).toEqual(["파일 전체가 아니라 일부 구간만 전달했습니다."]);
    expect(view.sources[0]!.label).toBe("제품계획.md · 40–41행");
  });

  it("개요 모드와 전달 구간 없음", () => {
    expect(presentMessageEvidence({ text: "답", evidence: { ...evidence, referenceMode: "overview", excerpted: false } })!.notes[0]).toContain("개요만");
    const none = presentMessageEvidence({ text: "답", evidence: { ...evidence, sources: [], referenceMode: "none" } })!;
    expect(none.summary).toContain("전달된 구간이 없습니다"); expect(none.undelivered).toEqual(["제품계획.md", "무관.md"]);
  });

  it("근거 없는 옛 메시지·문자열 content·깨진 근거는 표시하지 않거나 잘못된 항목만 버린다", () => {
    expect(presentMessageEvidence({ text: "옛 답변" })).toBeNull();
    expect(presentMessageEvidence("문자열")).toBeNull();
    expect(presentMessageEvidence(null)).toBeNull();
    expect(presentMessageEvidence({ text: "x", evidence: { ...evidence, version: 2 } })).toBeNull();
    const bad = presentMessageEvidence({ text: "x", evidence: { ...evidence, sources: [{ ...evidence.sources[0], id: "<img src=x>" }, { ...evidence.sources[0], endLine: 3 }, evidence.sources[0]] } })!;
    expect(bad.sources.map((source) => source.id)).toEqual(["R1"]);
  });

  it("전달 원문에 실제 행 번호를 붙인다", () => {
    expect(numberedExcerpt("출시일: 2026-11-03\n담당: 김하늘\n", 40)).toEqual([{ number: 40, text: "출시일: 2026-11-03" }, { number: 41, text: "담당: 김하늘" }]);
    expect(numberedExcerpt("끝 줄바꿈 없음", 7)).toEqual([{ number: 7, text: "끝 줄바꿈 없음" }]);
  });

  it("상태 문구: 불일치·파일 없음은 오류, 연결 해제·새 사본·일부는 경고", () => {
    const base: EvidenceView = { source: { id: "R1", fileId: FILE, fileName: "a", startLine: 1, endLine: 1 }, excerpt: "a\n", status: "attached", match: true, partial: false, newerSameName: false, context: null };
    expect(evidenceStatusMessages(base)).toEqual([{ tone: "ok", text: expect.stringContaining("일치") }]);
    expect(evidenceStatusMessages({ ...base, match: false })[0]!.tone).toBe("err");
    expect(evidenceStatusMessages({ ...base, status: "missing", match: null })[0]!.tone).toBe("err");
    const warned = evidenceStatusMessages({ ...base, status: "detached", match: null, newerSameName: true, partial: true });
    expect(warned.map((item) => item.tone)).toEqual(["warn", "warn", "warn"]);
    expect(warned.some((item) => item.tone === "ok")).toBe(false);
  });
});
