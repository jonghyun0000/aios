import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import type { AuthContext } from "@aios/shared";
import type { AppContext } from "../context.js";
import { registerChatRoutes } from "../routes/chat.js";
import { sessionLocks } from "../workspace.js";

const id = "10000000-0000-4000-8000-000000000001";
const url = `/v1/sessions/${id}/messages`;
function fixture(role: AuthContext["role"], via: "api_key" | "session" = "session", orgId = "org") {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select p.id as project_id")) return { rows: params[0] === id && params[1] === "org" ? [{ project_id: null, name: null }] : [] };
    if (sql.includes("select m.id, m.role")) return { rows: params[1] === "org" ? [{ id: "message", role: "user", content: { text: "합성 원문" } }] : [] };
    return { rows: [] };
  });
  const stream = vi.fn(async function* () {
    yield { type: "text_delta" as const, text: "합성 응답" };
    yield { type: "done" as const, stopReason: "end_turn" as const };
  });
  const record = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  const checkQuota = vi.fn(async () => {});
  const bind = vi.fn();
  const ctx = {
    env: {}, pool: { query }, router: { stream }, memory: { record }, retriever: { format: () => [] },
    bus: { publish }, usage: { checkQuota, bind },
  } as unknown as AppContext;
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId, role, via, scopes: ["*"], ...(via === "session" ? { userId: "user" } : {}) }; });
  app.setErrorHandler((err, _, reply) => reply.code(err instanceof AiosError ? err.status : 500).send({ error: (err as Error).message }));
  registerChatRoutes(app, ctx);
  return { app, ctx, query, stream, record, publish, checkQuota, bind };
}
const payload = { content: "합성 대화", tools: { enabled: false }, context: { useRag: false, useMemory: false, useLongTermMemory: false } };

describe("채팅은 도구 여부와 관계없이 쓰기 — 실제 라우트/오케스트레이터, 인증·DB·모델 대역", () => {
  it.each([
    { via: "api_key" as const, enabled: false }, { via: "session" as const, enabled: false },
    { via: "api_key" as const, enabled: true }, { via: "session" as const, enabled: true },
  ])("$via viewer는 tools=$enabled여도 DB/모델/쿼터 접근 전에 403", async ({ via, enabled }) => {
    const f = fixture("viewer", via);
    try {
      const response = await f.app.inject({ method: "POST", url, payload: { ...payload, tools: { enabled } } });
      if (response.statusCode === 200) {
        // 원래 결함 재현 시 단순 SSE 200이 아니라 실제 오케스트레이터의 저장/모델 경로도 확인한다.
        expect(f.stream).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledTimes(2);
        expect(f.query.mock.calls.filter(([sql]) => sql.includes("insert into messages"))).toHaveLength(2);
      }
      expect(response.statusCode).toBe(403);
      expect(f.query).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
      expect(f.checkQuota).not.toHaveBeenCalled(); expect(f.bind).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
      expect(sessionLocks(f.ctx).has(id)).toBe(false);
    } finally { await f.app.close(); }
  });
  it.each(["auto", "fast", "thorough"])("viewer는 %s 모드에서도 메시지를 쓰지 못한다", async (mode) => {
    const f = fixture("viewer");
    try {
      expect((await f.app.inject({ method: "POST", url, payload: { ...payload, mode } })).statusCode).toBe(403);
      expect(f.query).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(["api_key", "session"] as const)("%s member는 자기 조직에서 모델 응답과 대화 저장을 유지한다", async (via) => {
    const f = fixture("member", via);
    try {
      const response = await f.app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200); expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(response.body).toContain("합성 응답"); expect(response.body).toContain('"type":"done"');
      expect(f.stream).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledTimes(2);
      expect(f.query.mock.calls.filter(([sql]) => sql.includes("insert into messages"))).toHaveLength(2);
      expect(f.checkQuota).toHaveBeenCalledWith("org"); expect(sessionLocks(f.ctx).has(id)).toBe(false);
    } finally { await f.app.close(); }
  });
  it.each(["api_key", "session"] as const)("%s member라도 다른 조직의 대화는 404이며 모델/저장에 도달하지 않는다", async (via) => {
    const f = fixture("member", via, "other-org");
    try {
      expect((await f.app.inject({ method: "POST", url, payload })).statusCode).toBe(404);
      expect(f.query).toHaveBeenCalledOnce();
      expect(f.query.mock.calls[0]![0]).toContain("s.org_id = $2"); expect(f.query.mock.calls[0]![1]).toEqual([id, "other-org"]);
      expect(f.stream).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled(); expect(f.checkQuota).not.toHaveBeenCalled();
      expect(sessionLocks(f.ctx).has(id)).toBe(false);
    } finally { await f.app.close(); }
  });
  it.each(["org", "other-org"])("viewer의 읽기는 유지하되 %s 조직 범위를 벗어나지 않는다", async (orgId) => {
    const f = fixture("viewer", "session", orgId);
    try {
      const response = await f.app.inject(url);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ messages: unknown[] }>().messages).toHaveLength(orgId === "org" ? 1 : 0);
      expect(f.query.mock.calls[0]![0]).toContain("s.org_id = $2"); expect(f.query.mock.calls[0]![1]).toEqual([id, orgId]);
      expect(f.stream).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
