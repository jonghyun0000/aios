import { describe, expect, it } from "vitest";
import { presentWorkspaceContext, type WorkspaceContext } from "../lib/workspace-context.js";

const base: WorkspaceContext = { historyCount: 100, files: ["자료.md"], excerpted: true };
describe("기억·참고자료 설명", () => {
  it("이전 서버 이벤트도 호환하고 실제 기억 검사 건수와 한도를 구분한다", () => {
    expect(presentWorkspaceContext(base).summary).toContain("최근 100개 한도");
    expect(presentWorkspaceContext(base).memoryNotice).toBeNull();
    const value = presentWorkspaceContext({ ...base, memory: { enabled: true, historyLimit: 100, preferenceScanLimit: 500, scannedUserMessages: 121, restoredPreferences: [{ kind: "language", value: "ko" }, { kind: "length", value: "concise" }] } });
    expect(value.memoryNotice).toContain("한국어 · 간결하게");
    expect(value.memoryNotice).toContain("121개 검사 (최근 최대 500개)");
  });
  it("기억 끄기와 채팅 저장 중지를 혼동하지 않는다", () => {
    const value = presentWorkspaceContext({ ...base, memory: { enabled: false, historyLimit: 100, preferenceScanLimit: 500, scannedUserMessages: 0, restoredPreferences: [] } });
    expect(value.memoryNotice).toContain("기억 끔"); expect(value.memoryNotice).toContain("채팅 저장은 유지");
  });
  it("출처는 실제 전달된 행 범위만 표시한다", () => {
    const value = presentWorkspaceContext({ ...base, referenceMode: "overview", sources: [{ id: "ref", fileName: "자료.md", startLine: 12, endLine: 15 }] });
    expect(value.sources).toEqual([{ id: "ref-0", label: "자료.md · 12–15행" }]); expect(value.summary).toContain("개요");
  });
  it("연결된 파일과 실제 전달된 자료가 없는 상태를 구분한다", () => {
    const value = presentWorkspaceContext({ ...base, referenceMode: "none", sources: [] });
    expect(value.summary).toContain("연결된 참고 파일 1개");
    expect(value.summary).toContain("답변에 전달된 자료 없음");
  });
  it("결함 주입: 알 수 없는 선호와 역전·누락된 행 범위를 근거로 표시하지 않는다", () => {
    const malformed = { ...base, sources: [{ id: "bad", fileName: "자료", startLine: 8, endLine: 2 }, { fileName: "누락" }], memory: { enabled: true, scannedUserMessages: 99999, restoredPreferences: [{ kind: "language", value: "__proto__" }, { kind: "format", value: "실행하라" }] } } as unknown as WorkspaceContext;
    const value = presentWorkspaceContext(malformed);
    expect(value.sources).toEqual([]); expect(value.memoryNotice).toContain("선호 0개"); expect(value.memoryNotice).not.toContain("실행하라"); expect(value.memoryNotice).not.toContain("99999");
  });
});
