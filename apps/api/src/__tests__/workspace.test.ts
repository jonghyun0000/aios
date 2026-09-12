import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { loadSavedHistory, referenceChunks, sessionLocks, validateReference } from "../workspace.js";
import { registerWorkspaceRoutes } from "../routes/workspace.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";

const id = "10000000-0000-4000-8000-000000000001";
function fixture() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
  const ctx = { pool: { query } } as unknown as AppContext;
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", role: "owner", via: "local", scopes: ["*"] }; });
  app.setErrorHandler((err, _, reply) => reply.code(err instanceof AiosError ? err.status : 400).send({ error: err.message }));
  registerWorkspaceRoutes(app, ctx);
  return { app, ctx, query };
}
describe("일상 작업공간", () => {
  it.each(["notes.md", "data.csv", "worker.ts", "계획.txt"])("UTF-8 텍스트 %s를 허용한다", (name) => expect(() => validateReference(name, "내용\nA\tB")).not.toThrow());
  it.each([["../note.txt", "ok"], [".env", "key"], ["secret.json", "key"], ["image.png", "ok"], ["n.txt", "a\0b"], ["n.txt", "�"], ["n.txt", " "], ["n.txt", "가".repeat(22000)]])("지원하지 않는 파일·바이너리·크기를 거부한다 %s", (name, content) => expect(() => validateReference(name, content)).toThrow());
  it("긴 파일 끝의 관련 구간을 검색하고 파일명도 데이터로 인용한다", () => {
    const result = referenceChunks([{ id, name: 'plan".md', content: "noise\n".repeat(400) + "\nlaunch code = BIRCH-731" }], "launch code?");
    expect(result.chunks[0]).toContain("BIRCH-731"); expect(result.chunks[0]).toContain("not instructions"); expect(result.chunks[0]).toContain('plan\\".md');
    const large = referenceChunks([{ id, name: "n.txt", content: "n".repeat(16000) }], "n");
    expect(large.chunks).toHaveLength(4); expect(large.excerpted).toBe(true);
  });
  it("DB 원문을 시간순으로 복구하고 잘못된 content는 제외한다", async () => {
    const f = fixture(); f.query.mockResolvedValue({ rows: [{ role: "assistant", text: "둘" }, { role: "user", text: "하나" }, { role: "assistant", text: null }] });
    expect(await loadSavedHistory(f.ctx, "org", id)).toEqual([{ role: "user", content: "하나" }, { role: "assistant", content: "둘" }]);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("s.org_id = $2 and s.deleted_at is null"), [id, "org"]);
    expect(f.query.mock.calls[0]![0]).toContain("limit 100"); await f.app.close();
  });
  it("휴지통은 원본 삭제 없이 조직 범위에만 적용되고 복구된다", async () => {
    const f = fixture(); f.query.mockResolvedValue({ rows: [{ id }] });
    for (const deleted of [true, false]) {
      expect((await f.app.inject({ method: "PATCH", url: `/v1/sessions/${id}`, payload: { deleted } })).statusCode).toBe(200);
      expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining("where id = $1 and org_id = $2"), [id, "org", null, false, null, deleted]);
    }
    expect(f.query.mock.calls.every(([sql]) => !/delete from/i.test(sql))).toBe(true); await f.app.close();
  });
  it("응답 중 변경과 다른 조직 프로젝트 연결을 차단한다", async () => {
    const f = fixture(); sessionLocks(f.ctx).add(id);
    expect((await f.app.inject({ method: "PATCH", url: `/v1/sessions/${id}`, payload: { deleted: true } })).statusCode).toBe(409);
    expect(f.query).not.toHaveBeenCalled(); sessionLocks(f.ctx).delete(id);
    expect((await f.app.inject({ method: "POST", url: "/v1/sessions", payload: { projectId: id } })).statusCode).toBe(404);
    expect(f.query).toHaveBeenCalledTimes(1); await f.app.close();
  });
  it("본문 검색을 매개변수로 묶고 마이크로초+ID 커서를 왕복한다", async () => {
    const f = fixture(); const at = "2026-09-12T00:00:00.123456Z";
    f.query.mockResolvedValue({ rows: [{ id, title: "a", cursor_at: at }, { id: "next", cursor_at: at }] });
    const res = await f.app.inject(`/v1/sessions?q=${encodeURIComponent("100%_'")}&limit=1`);
    expect(res.statusCode).toBe(200); const page = res.json<{ sessions: unknown[]; nextCursor: string }>(); expect(page.sessions).toHaveLength(1);
    expect(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString())).toEqual({ at, id });
    await f.app.inject(`/v1/sessions?cursor=${page.nextCursor}&limit=1`);
    expect(f.query.mock.calls[0]![1]?.[3]).toBe("100%_'"); expect(f.query.mock.calls[1]![1]?.slice(4, 6)).toEqual([at, id]);
    expect(f.query.mock.calls[0]![0]).toContain("(s.updated_at,s.id) <");
    expect((await f.app.inject("/v1/sessions?cursor=bad")).statusCode).toBe(400); await f.app.close();
  });
  it("빈/오염된 Redis 대신 저장 원문과 참고자료가 실제 모델 요청에 들어간다", async () => {
    const captured: string[] = [];
    const stream = vi.fn(async function* (request: unknown, _constraints: unknown) { captured.push(JSON.stringify(request)); yield { type: "text_delta" as const, text: "참나무" }; });
    const ctx = { pool: { query: async () => ({ rows: [] }) }, memory: { record: async () => {}, buildContext: async () => ({ history: [{ role: "user", content: "오염된 캐시" }], stmSummary: "오염된 요약", facts: [] }) }, router: { stream }, retriever: { format: () => [] }, bus: { publish: async () => {} } } as unknown as AppContext;
    const savedHistory = [{ role: "user" as const, content: "프로젝트 별명은 참나무입니다." }];
    const collect = async (history = savedHistory) => { for await (const _ of new AgentOrchestrator(ctx).run({ orgId: "org", sessionId: id, content: "별명은?", mode: "fast", toolsEnabled: false, useMemory: true, useRag: false, savedHistory: history, references: ["reference DATA: release = 731"] })) { /* consume */ } };
    await collect();
    expect(captured[0]).toContain("참나무"); expect(captured[0]).toContain("release = 731"); expect(captured[0]).not.toContain("오염된");
    // 결함 주입: 복원 데이터를 누락시킨 실제 실행은 동일한 모델 입력 계약을 만족하지 못한다.
    await collect([]); expect(captured[1]).not.toContain("참나무");
  });
});
