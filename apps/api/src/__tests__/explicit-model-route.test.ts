import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import { AiRouter, localModels, type ProviderAdapter } from "@aios/ai";
import type { AppContext } from "../context.js";
import { registerChatRoutes } from "../routes/chat.js";

const SESSION = "10000000-0000-4000-8000-000000000001";
/** docs/41: 잘못된 명시 모델은 스트림·저장 전에 400. 설정된 모델은 실제 라우터를 거쳐 그 모델로 답한다. */
function fixture() {
  const inserts: string[] = [];
  const seen: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select p.id as project_id")) return { rows: [{ project_id: null, name: null }] };
    if (sql.includes("insert into messages")) inserts.push(params[2] as string);
    return { rows: [] };
  });
  const local: ProviderAdapter = { id: "local", async *stream(req) { seen.push(req.model); yield { type: "text_delta", text: "안녕" }; yield { type: "done", stopReason: "end_turn" }; } };
  const router = new AiRouter({ local }, { catalog: localModels(["qwen3:8b", "exaone3.5:7.8b"], 32768) });
  const ctx = {
    env: { LOCAL_LLM_BASE_URL: "http://127.0.0.1:11434/v1", LOCAL_LLM_CONTEXT: 32768 }, pool: { query }, router,
    memory: { record: async () => {}, buildContext: async () => ({ history: [], stmSummary: null, facts: [] }) },
    retriever: { format: () => [] }, bus: { publish: async () => {} }, usage: { bind: () => {} },
  } as unknown as AppContext;
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", via: "local", role: "member", scopes: ["*"] }; });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof AiosError ? err.status : 500).send({ error: { code: err instanceof AiosError ? err.code : "internal", message: (err as Error).message } }));
  registerChatRoutes(app, ctx);
  const send = (model: string) => app.inject({ method: "POST", url: `/v1/sessions/${SESSION}/messages`, payload: { content: "인사", mode: "fast", tools: { enabled: false }, routing: { model }, context: { useMemory: false, useLongTermMemory: false, useRag: false } } });
  return { app, inserts, seen, send };
}

describe("채팅 라우트의 명시 모델", () => {
  it("설정된 로컬 모델은 그 모델로 답하고 두 메시지를 저장한다", async () => {
    const f = fixture();
    try {
      const res = await f.send("exaone3.5:7.8b");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"type":"routed"'); expect(res.body).toContain('"model":"exaone3.5:7.8b"');
      expect(f.seen).toEqual(["exaone3.5:7.8b"]); expect(f.inserts).toEqual(["user", "assistant"]);
    } finally { await f.app.close(); }
  });

  it.each(["llama3.1:8b", "없는-모델", "claude-sonnet-4-5"])("%s: 스트림 전 400, 메시지 저장·모델 호출 없음", async (model) => {
    const f = fixture();
    try {
      const res = await f.send(model);
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toMatchObject({ error: { code: "unknown_model" } });
      expect(res.json().error.message).toContain("available: qwen3:8b, exaone3.5:7.8b");
      expect(f.inserts).toEqual([]); expect(f.seen).toEqual([]);
    } finally { await f.app.close(); }
  });
});
