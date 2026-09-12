import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import type { AppContext } from "../context.js";

const mocks = vi.hoisted(() => ({ realpath: vi.fn(), lstat: vi.fn(), enqueue: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), realpath: mocks.realpath, lstat: mocks.lstat }));
vi.mock("../queue.js", () => ({ enqueueIndexJob: mocks.enqueue }));
import { validateIndexRoot, runIndexJob } from "../index-boundary.js";
import { registerCoreRoutes } from "../routes/core.js";

const root = "/fixture/workspace";
const projectId = "10000000-0000-4000-8000-000000000001";
const directory = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false, nlink: 1 };
const linked = { isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false, nlink: 1 };
const hardlinked = { isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true, nlink: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.realpath.mockImplementation(async (path: string) => path);
  mocks.lstat.mockResolvedValue(directory);
  mocks.enqueue.mockResolvedValue("fixture-job");
});
function fixture(role: "viewer" | "member" = "member") {
  const query = vi.fn(async (sql: string) => ({ rows: [{ id: sql.includes("organizations") ? "org" : projectId }] }));
  const indexProject = vi.fn(async () => ({ added: 1, updated: 0, removed: 0 }));
  const ctx = { env: { LOCAL_WORKSPACE_ROOT: root, LOCAL_NO_AUTH_ORG_SLUG: "local" }, pool: { query }, indexer: { indexProject } } as unknown as AppContext;
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", role, via: "api_key", scopes: ["*"] }; });
  app.setErrorHandler((err, _, reply) => reply.code(err instanceof AiosError ? err.status : 500).send({ error: err.message }));
  registerCoreRoutes(app, ctx);
  return { app, ctx, query, indexProject };
}
describe("색인 API와 워커의 로컬 조직·실제 파일 경계 (FS/DB 대역)", () => {
  it("viewer는 큐/DB 접근 전에 거부된다", async () => {
    const f = fixture("viewer");
    try {
      expect((await f.app.inject({ method: "POST", url: `/v1/projects/${projectId}/index`, payload: { rootDir: root } })).statusCode).toBe(403);
      expect(f.query).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("member는 지정 조직의 작업 폴더 하위만 큐에 넣는다", async () => {
    const f = fixture();
    try {
      expect((await f.app.inject({ method: "POST", url: `/v1/projects/${projectId}/index`, payload: { rootDir: `${root}/src` } })).statusCode).toBe(202);
      expect(mocks.enqueue).toHaveBeenCalledWith(f.ctx, { orgId: "org", projectId, rootDir: `${root}/src` });
    } finally { await f.app.close(); }
  });
  it.each(["/fixture/private", "/fixture/workspace-other", `${root}/../private`, "relative/path"])("API가 외부/상대 경로 %s를 큐에 넣지 않는다", async (rootDir) => {
    const f = fixture();
    try {
      expect((await f.app.inject({ method: "POST", url: `/v1/projects/${projectId}/index`, payload: { rootDir } })).statusCode).toBe(403);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("설정이 없는 비로컬 배포에서는 색인을 시작하지 않는다", async () => {
    const f = fixture(); f.ctx.env.LOCAL_WORKSPACE_ROOT = undefined;
    await expect(validateIndexRoot(f.ctx, projectId, "org", root)).rejects.toMatchObject({ status: 409 });
    expect(f.query).not.toHaveBeenCalled(); await f.app.close();
  });
  it("프로젝트 소유권과 호스트 작업 폴더의 조직 소유권을 모두 검사한다", async () => {
    const f = fixture(); f.query.mockResolvedValueOnce({ rows: [] });
    await expect(validateIndexRoot(f.ctx, projectId, "org", root)).rejects.toMatchObject({ status: 404 });
    await expect(validateIndexRoot(f.ctx, projectId, "other-org", root)).rejects.toMatchObject({ status: 403 });
    expect(mocks.realpath).not.toHaveBeenCalled(); await f.app.close();
  });
  it("설정 루트와 요청 중간 경로의 심볼릭 링크를 거부한다", async () => {
    const f = fixture();
    mocks.realpath.mockResolvedValueOnce("/fixture/private");
    await expect(validateIndexRoot(f.ctx, projectId, "org", root)).rejects.toMatchObject({ status: 403 });
    mocks.lstat.mockResolvedValueOnce(linked);
    await expect(validateIndexRoot(f.ctx, projectId, "org", `${root}/linked/src`)).rejects.toMatchObject({ status: 403 });
    await f.app.close();
  });
  it("큐의 오래된/조작된 rootDir도 실제 워커 경로에서 다시 거부한다", async () => {
    const f = fixture();
    await expect(runIndexJob(f.ctx, { projectId, orgId: "org", rootDir: "/fixture/private" })).rejects.toMatchObject({ status: 403 });
    expect(f.indexProject).not.toHaveBeenCalled(); await f.app.close();
  });
  it("워커는 파일별 검증 callback을 반드시 전달하며 .gitignore 링크·하드링크도 차단한다", async () => {
    const f = fixture();
    await expect(runIndexJob(f.ctx, { projectId, orgId: "org", rootDir: root })).resolves.toEqual({ added: 1, updated: 0, removed: 0 });
    const validate = (f.indexProject.mock.calls[0] as unknown as [unknown, unknown, unknown, (path: string) => Promise<void>])[3];
    expect(validate).toBeTypeOf("function");
    mocks.lstat.mockResolvedValueOnce(linked);
    await expect(validate(`${root}/.gitignore`)).rejects.toMatchObject({ status: 403 });
    mocks.lstat.mockResolvedValueOnce(hardlinked);
    await expect(validate(`${root}/private.md`)).rejects.toMatchObject({ status: 403 });
    await expect(validate("/fixture/private.md")).rejects.toMatchObject({ status: 403 });
    await f.app.close();
  });
});
