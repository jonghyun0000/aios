import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { registerChatRoutes } from "../routes/chat.js";
import type { AppContext } from "../context.js";

const sessionId = "10000000-0000-4000-8000-000000000001";

describe("채팅 중단과 대화 잠금", () => {
  it("중복 요청을 거부하고 연결을 끊으면 작업을 취소한 뒤 잠금을 푼다", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(AgentOrchestrator.prototype, "run").mockImplementation(async function* (input) {
      signals.push(input.signal!);
      yield { type: "text_delta", text: "시작" };
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
    const app = Fastify();
    app.addHook("preHandler", async (req) => { req.auth = { orgId: "local", role: "owner", scopes: ["*"], via: "local" }; });
    registerChatRoutes(app, {
      env: { LOCAL_WORKSPACE_ROOT: "/Volumes/T7/bigdata/workspaces/my-first-project" },
      pool: { query: async () => ({ rows: [{ project_id: null, name: null }] }) },
      usage: { checkQuota: async () => {}, bind: () => {} },
    } as unknown as AppContext);
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const ac = new AbortController();
    const second = new AbortController();
    const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "test", tools: { enabled: false } }) };
    try {
      const response = await fetch(`${url}/v1/sessions/${sessionId}/messages`, { ...options, signal: ac.signal });
      const reader = response.body!.getReader();
      await reader.read();
      expect(signals).toHaveLength(1);
      const conflict = await fetch(`${url}/v1/sessions/${sessionId}/messages`, options);
      expect(conflict.status).toBe(409);
      ac.abort();
      await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
      let resumed: Response | undefined;
      await vi.waitFor(async () => {
        resumed = await fetch(`${url}/v1/sessions/${sessionId}/messages`, { ...options, signal: second.signal });
        expect(resumed.status).toBe(200);
      });
      second.abort();
      await vi.waitFor(() => expect(signals[1]!.aborted).toBe(true));
    } finally {
      ac.abort(); second.abort(); await app.close();
    }
  });
});
