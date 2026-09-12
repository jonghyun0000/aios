import { describe, expect, it, vi } from "vitest";
import { AgentOrchestrator, type RunInput } from "../agent/orchestrator.js";
import type { AppContext } from "../context.js";
import type { AgentEvent, ChatMessage, StreamEvent } from "@aios/shared";
function fixture() {
  const history: ChatMessage[] = [];
  const record = vi.fn(async (_: string, m: ChatMessage) => { history.push(m); });
  const buildContext = vi.fn(async () => ({ history: [...history], stmSummary: null, facts: [] }));
  const query = vi.fn(async () => ({ rows: [] })); const publish = vi.fn(async () => {});
  const stream = vi.fn(async function* (): AsyncGenerator<StreamEvent> { yield { type: "text_delta", text: "응답" }; yield { type: "done", stopReason: "end_turn" }; });
  const agent = new AgentOrchestrator({ memory: { record, buildContext }, pool: { query }, bus: { publish }, router: { stream }, retriever: { format: () => [] } } as unknown as AppContext);
  return { agent, query, publish, stream, buildContext, history };
}
const input: RunInput = { orgId: "org", sessionId: "s", content: "17*23+41", mode: "auto", toolsEnabled: false, useMemory: true, useRag: false };
async function collect(agent: AgentOrchestrator, request = input) { const events: AgentEvent[] = []; for await (const event of agent.run(request)) events.push(event); return events; }
describe("자동 응답 오케스트레이션", () => {
  it("계산은 모델/검색 없이 수행하고 양쪽 메시지를 저장한다", async () => {
    const f = fixture(); const events = await collect(f.agent);
    expect(f.stream).not.toHaveBeenCalled(); expect(f.buildContext).not.toHaveBeenCalled();
    expect(f.history).toEqual([{ role: "user", content: "17*23+41" }, { role: "assistant", content: "432" }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "strategy", path: "calculator" }));
    expect(events).toContainEqual({ type: "text_delta", text: "432" });
    expect(events).toContainEqual(expect.objectContaining({ type: "timing", phase: "total" }));
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ extractFacts: false }) }));
    // 결함 주입: 모델 오답으로 계산 결과를 바꾸면 실제 이벤트 계약이 실패한다.
    const broken = events.map((e) => e.type === "text_delta" ? { ...e, text: "403" } : e);
    expect(() => expect(broken).toContainEqual({ type: "text_delta", text: "432" })).toThrow();
  });
  it.each([["안녕", "off", false], ["TypeScript function 구현", "auto", true]])("%s의 추론과 메모리 설정을 실제 라우터에 전달한다", async (content, reasoning, useLongTermMemory) => {
    const f = fixture(); await collect(f.agent, { ...input, content });
    expect(f.stream).toHaveBeenCalledWith(expect.objectContaining({ reasoning }), expect.anything());
    expect(f.stream).toHaveBeenCalledWith(expect.objectContaining({ system: expect.stringContaining("No tools are enabled") }), expect.anything());
    expect(f.buildContext).toHaveBeenCalledWith(expect.anything(), "s", content, { useLongTermMemory });
  });
  it("중단된 계산을 저장·완료로 표시하지 않는다", async () => {
    const f = fixture(); const ac = new AbortController(); ac.abort();
    await expect(collect(f.agent, { ...input, signal: ac.signal })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("오래된 문맥 제외를 고지하고 원본 기록은 보존한다", async () => {
    const f = fixture(); const old = { role: "user" as const, content: "old note ".repeat(1000) }; f.history.push(old);
    const events = await collect(f.agent, { ...input, content: "안녕", budgetTokens: 700 });
    expect(events).toContainEqual({ type: "context_trimmed", sections: [{ section: "history", count: 1 }] });
    expect(f.history[0]).toBe(old);
  });
  it("자동이 빠른 경로를 선택하면 명시적 빠른 모드와 동일한 문맥·요청을 보낸다", async () => {
    const auto = fixture(); const fast = fixture();
    const history: ChatMessage[] = [{ role: "user", content: "이 대화에서는 답변을 한국어로 해줘." }, { role: "assistant", content: "확인했습니다." }];
    auto.history.push(...history); fast.history.push(...history);
    const content = "What language did I ask you to use? Reply with only its Korean name.";
    await collect(auto.agent, { ...input, content }); await collect(fast.agent, { ...input, content, mode: "fast" });
    expect(auto.stream.mock.calls).toEqual(fast.stream.mock.calls);
    const missing = fixture(); await collect(missing.agent, { ...input, content });
    expect(() => expect(missing.stream.mock.calls).toEqual(auto.stream.mock.calls)).toThrow();
  });
  it("너무 긴 단일 입력을 조용히 잘라 저장하지 않는다", async () => {
    const f = fixture();
    await expect(collect(f.agent, { ...input, content: "가".repeat(200), budgetTokens: 128 })).rejects.toThrow("입력 한도");
    expect(f.query).not.toHaveBeenCalled();
  });
  it("결함 주입: 빈 응답과 출력 한도 종료를 성공으로 위장하지 않는다", async () => {
    const f = fixture(); f.stream.mockImplementation(async function* () { yield { type: "done", stopReason: "max_tokens" }; });
    await expect(collect(f.agent, { ...input, content: "안녕" })).rejects.toThrow("표시 가능한 답변");
    const partial = fixture(); partial.stream.mockImplementation(async function* () { yield { type: "text_delta", text: "중간 답" }; yield { type: "done", stopReason: "max_tokens" }; });
    const events = await collect(partial.agent, { ...input, content: "안녕" });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "response_truncated" }));
    expect(partial.history.at(-1)?.content).toBe("중간 답");
  });
});
