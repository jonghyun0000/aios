import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_LIMITS, NEW_CHAT, clearAllDrafts, loadDraft, saveDraft } from "../lib/chat-drafts.js";

class MemoryStorage { map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }
let mem: MemoryStorage;
beforeEach(() => { mem = new MemoryStorage(); vi.stubGlobal("localStorage", mem); });
afterEach(() => vi.unstubAllGlobals());

describe("대화별 초안", () => {
  it("대화마다 따로 보관하고, 빈 입력은 지운다", () => {
    expect(saveDraft("A", "A 초안")).toBe("saved"); expect(saveDraft("B", "B 초안")).toBe("saved"); saveDraft(NEW_CHAT, "새 대화 초안");
    expect([loadDraft("A"), loadDraft("B"), loadDraft(NEW_CHAT), loadDraft("C")]).toEqual(["A 초안", "B 초안", "새 대화 초안", ""]);
    expect(saveDraft("A", "   ")).toBe("cleared"); expect(loadDraft("A")).toBe(""); expect(loadDraft("B")).toBe("B 초안");
  });
  it(`${DRAFT_LIMITS.entries}개를 넘으면 가장 오래된 것부터 버린다`, () => {
    for (let i = 0; i <= DRAFT_LIMITS.entries; i++) saveDraft(`s${i}`, `초안 ${i}`, 1000 + i);
    expect(loadDraft("s0", 2000)).toBe(""); expect(loadDraft("s1", 2000)).toBe("초안 1"); expect(loadDraft(`s${DRAFT_LIMITS.entries}`, 2000)).toBe(`초안 ${DRAFT_LIMITS.entries}`);
  });
  it("7일이 지나면 돌려주지 않는다", () => {
    saveDraft("A", "오래된 초안", 0);
    expect(loadDraft("A", DRAFT_LIMITS.ttlMs)).toBe("오래된 초안"); expect(loadDraft("A", DRAFT_LIMITS.ttlMs + 1)).toBe("");
  });
  it("50,000자를 넘는 초안은 저장하지 않고 알린다(이전 초안도 남기지 않는다)", () => {
    saveDraft("A", "짧은 초안");
    expect(saveDraft("A", "가".repeat(DRAFT_LIMITS.chars + 1))).toBe("too_long"); expect(loadDraft("A")).toBe("");
    expect(saveDraft("A", "가".repeat(DRAFT_LIMITS.chars))).toBe("saved");
  });
  it("깨진 기록·저장소 예외에도 던지지 않는다", () => {
    mem.setItem("aios.chat-drafts.v1", "{깨짐"); expect(loadDraft("A")).toBe("");
    mem.setItem("aios.chat-drafts.v1", JSON.stringify({ A: { text: 5, at: 1 }, B: null, C: { text: "정상", at: Date.now() } })); expect(loadDraft("A")).toBe(""); expect(loadDraft("C")).toBe("정상");
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });
    expect(loadDraft("A")).toBe(""); expect(saveDraft("A", "초안")).toBe("unavailable"); expect(() => clearAllDrafts()).not.toThrow();
  });
  it("로그아웃용 전체 삭제", () => { saveDraft("A", "a"); saveDraft("B", "b"); clearAllDrafts(); expect(loadDraft("A") + loadDraft("B")).toBe(""); });
});
