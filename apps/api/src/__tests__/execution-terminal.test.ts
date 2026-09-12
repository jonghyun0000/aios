import { describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import type { AppContext } from "../context.js";
import type { ExecutionRun } from "../execution/service.js";
import type { AgentEvent } from "@aios/shared";

const input = { orgId: "org", sessionId: "session", content: "작업", toolsEnabled: false, useRag: false, useMemory: false };
function fixture(stream: () => AsyncGenerator<AgentEvent>) {
  const query = vi.fn(async () => ({ rows: [] }));
  const ctx = { pool: { query }, memory: { record: async () => {} }, retriever: { format: () => [] }, router: { stream }, bus: { publish: async () => {} } } as unknown as AppContext;
  return { query, agent: new AgentOrchestrator(ctx) };
}
describe("신뢰 가능한 종료 이벤트", () => {
  it("모델 done보다 저장·검증·실행 기록 완료가 먼저다", async () => {
    const order: string[] = [];
    const f = fixture(async function* () { yield { type: "text_delta", text: "완료 주장" }; yield { type: "done", stopReason: "end_turn" }; });
    const execution = { verify: async () => { order.push("verify"); }, finish: async () => { order.push("journal"); } } as unknown as ExecutionRun;
    for await (const event of f.agent.run({ ...input, execution })) {
      if (event.type === "done") { order.push("done"); expect(f.query).toHaveBeenCalledWith(expect.stringContaining("insert into messages"), expect.arrayContaining(["assistant"])); }
    }
    expect(order).toEqual(["verify", "journal", "done"]);
  });
  it("검증 예외·모델 종료 누락을 주입하면 성공 종료를 내보내지 않는다", async () => {
    for (const missingDone of [false, true]) {
      const f = fixture(async function* () { yield { type: "text_delta", text: "성공이라고 주장" }; if (!missingDone) yield { type: "done", stopReason: "end_turn" }; });
      const events: AgentEvent[] = [];
      for await (const event of f.agent.run({ ...input, completionCheck: missingDone ? undefined : async () => { throw new Error("검증기 장애"); } })) events.push(event);
      expect(events).not.toContainEqual({ type: "done", stopReason: "end_turn" });
      expect(events).toContainEqual({ type: "done", stopReason: "error" });
    }
  });
  it("저장 장애를 주입하면 done 이전에 실패한다", async () => {
    const f = fixture(async function* () { yield { type: "text_delta", text: "성공 주장" }; yield { type: "done", stopReason: "end_turn" }; });
    f.query.mockImplementation(async (_sql?: string, values?: unknown[]) => { if (values?.[2] === "assistant") throw new Error("DB unavailable"); return { rows: [] }; });
    const events: AgentEvent[] = [];
    await expect((async () => { for await (const event of f.agent.run(input)) events.push(event); })()).rejects.toThrow("DB unavailable");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});
