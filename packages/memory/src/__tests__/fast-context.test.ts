import { describe, it, expect, vi } from "vitest";
import { MemoryEngine } from "../engine.js";
import type { ShortTermMemory } from "../short-term.js";
import type { LongTermMemory } from "../long-term.js";

describe("빠른 응답의 대화 맥락", () => {
  const history = [{ role: "user", content: "내 프로젝트 이름은 별빛" }, { role: "assistant", content: "기억할게요" }];
  const recall = vi.fn(async () => [{ kind: "fact", content: "지난 대화 기억" }]);
  const engine = new MemoryEngine(
    { getWindow: async () => ({ summary: "이전 요약", messages: history }) } as unknown as ShortTermMemory,
    { recall } as unknown as LongTermMemory,
    { summarize: async () => "", extractFacts: async () => [] },
  );
  it("임베딩 검색을 건너뛰어도 대화와 요약은 그대로 유지한다", async () => {
    recall.mockClear();
    const context = await engine.buildContext({ orgId: "test" }, "session", "이름?", { useLongTermMemory: false });
    expect(context).toEqual({ stmSummary: "이전 요약", history, facts: [] });
    expect(recall).not.toHaveBeenCalled();
  });
  it("깊이 생각/기존 호출은 장기기억도 검색한다", async () => {
    recall.mockClear();
    const context = await engine.buildContext({ orgId: "test" }, "session", "이름?");
    expect(context.facts).toEqual(["[fact] 지난 대화 기억"]);
    expect(recall).toHaveBeenCalledOnce();
  });
  it("결함 주입: 빠른 모드 플래그 유실을 검출한다", async () => {
    recall.mockClear();
    await engine.buildContext({ orgId: "test" }, "session", "이름?", {});
    expect(() => expect(recall).not.toHaveBeenCalled()).toThrow();
  });
});
