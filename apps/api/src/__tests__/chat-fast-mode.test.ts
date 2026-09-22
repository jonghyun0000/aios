import Fastify from "fastify";
import { afterEach, describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { registerChatRoutes } from "../routes/chat.js";
import type { AppContext } from "../context.js";
import type { CompletionRequest } from "@aios/shared";

const sessionUrl = "/v1/sessions/10000000-0000-4000-8000-000000000001/messages";

afterEach(() => vi.restoreAllMocks());
describe("채팅 모드 전달", () => {
  it("빠른 모드는 기록을 유지하고 추론/장기기억만 끈다", async () => {
    const run = vi.spyOn(AgentOrchestrator.prototype, "run").mockImplementation(async function* () { yield { type: "done", stopReason: "end_turn" }; });
    const app = Fastify();
    app.addHook("preHandler", async (req) => { req.auth = { orgId: "local", role: "owner", scopes: ["*"], via: "local" }; });
    registerChatRoutes(app, {
      env: {}, pool: { query: async (sql: string) => ({ rows: sql.includes("select p.id as project_id") ? [{ project_id: null, name: null }] : [] }) }, usage: { bind: () => {} },
    } as unknown as AppContext);
    try {
      const response = await app.inject({ method: "POST", url: sessionUrl, payload: {
        content: "안녕", tools: { enabled: false }, routing: { reasoning: "off", taskClass: "chat" }, context: { useLongTermMemory: false },
      } });
      expect(response.statusCode).toBe(200);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ reasoning: "off", useMemory: true, useLongTermMemory: false, toolsEnabled: false, taskClass: "chat" }));
      await app.inject({ method: "POST", url: sessionUrl, payload: { content: "기존 호출", tools: { enabled: false } } });
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ useLongTermMemory: true, useMemory: true, reasoning: undefined }));
      await app.inject({ method: "POST", url: sessionUrl, payload: { content: "17*23+41", mode: "auto", tools: { enabled: false } } });
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "auto", toolsEnabled: false }));
      const invalid = await app.inject({ method: "POST", url: sessionUrl, payload: { content: "안녕", mode: "typo" } });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    } finally { await app.close(); }
  });
  it("오케스트레이터가 추론 옵션과 백그라운드 추출 제외를 전달한다", async () => {
    const buildContext = vi.fn(async () => ({ stmSummary: null, history: [{ role: "user", content: "안녕" }], facts: [] }));
    const stream = vi.fn(async function* (_request: Omit<CompletionRequest, "model">, _constraints: unknown) { yield { type: "text_delta", text: "안녕하세요" }; yield { type: "done", stopReason: "end_turn" }; });
    const publish = vi.fn(async () => {});
    const query = vi.fn(async () => ({ rows: [] }));
    const agent = new AgentOrchestrator({
      memory: { record: async () => {}, buildContext }, pool: { query }, router: { stream },
      retriever: { format: () => [] }, bus: { publish },
    } as unknown as AppContext);
    for await (const _ of agent.run({ orgId: "org", sessionId: "session", content: "안녕", toolsEnabled: false, useRag: false, useMemory: true, useLongTermMemory: false, reasoning: "off" })) { /* consume */ }
    expect(buildContext).toHaveBeenCalledWith(expect.anything(), "session", "안녕", { useLongTermMemory: false });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ reasoning: "off" }), expect.anything());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ extractFacts: false }) }));
    expect(query).toHaveBeenCalledWith("update sessions set updated_at = now() where id = $1", ["session"]);
    // 결함 주입: 추론 설정을 버린 실제 호출 인자를 검사하면 반드시 실패해야 한다.
    const broken = { ...stream.mock.calls[0]![0], reasoning: undefined };
    expect(() => expect(broken).toMatchObject({ reasoning: "off" })).toThrow();
  });
});
