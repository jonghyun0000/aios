import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { registerCoreRoutes } from "../routes/core.js";

const id = "10000000-0000-4000-8000-000000000001";
function fixture(role: "viewer" | "member") {
  const query = vi.fn(async () => ({ rows: [{ id, project_id: null, n: 0 }], rowCount: 1 }));
  const remember = vi.fn(async () => ({ id }));
  const forget = vi.fn(async () => true);
  const ctx = { pool: { query, connect: async () => ({ query, release() {} }) }, memory: { ltm: { remember, forget } } } as unknown as AppContext;
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", role, via: "session", scopes: ["*"] }; });
  app.setErrorHandler((err, _, reply) => reply.code(err instanceof AiosError ? err.status : 500).send({ error: err.message }));
  registerCoreRoutes(app, ctx);
  return { app, query, remember, forget };
}
const changes = [
  { method: "POST" as const, url: "/v1/sessions", payload: { title: "fixture" } },
  { method: "PATCH" as const, url: `/v1/sessions/${id}`, payload: { deleted: true } },
  { method: "POST" as const, url: `/v1/sessions/${id}/files`, payload: { name: "note.md", content: "fixture" } },
  { method: "DELETE" as const, url: `/v1/sessions/${id}/files/${id}` },
  { method: "POST" as const, url: "/v1/memory", payload: { kind: "fact", content: "fixture" } },
  { method: "DELETE" as const, url: `/v1/memory/${id}` },
];

describe("viewer는 읽기 전용 — 실제 라우트, DB/메모리 대역", () => {
  it.each(changes)("$method $url은 viewer의 저장·삭제 전에 403", async (request) => {
    const f = fixture("viewer");
    try {
      expect((await f.app.inject(request)).statusCode).toBe(403);
      expect(f.query).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      expect(f.forget).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(changes)("$method $url은 member의 기존 쓰기를 유지", async (request) => {
    const f = fixture("member");
    try { expect((await f.app.inject(request)).statusCode).toBe(200); }
    finally { await f.app.close(); }
  });
  it("viewer의 기존 프로젝트 읽기는 유지", async () => {
    const f = fixture("viewer");
    try { expect((await f.app.inject("/v1/projects")).statusCode).toBe(200); }
    finally { await f.app.close(); }
  });
});
