import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { ToolExecutor, ToolRegistry, writeFileTool } from "@aios/tools";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { ExecutionService } from "../execution/service.js";

function isolatedDatabaseUrl(raw: string | undefined): URL {
  let url: URL;
  try { if (!raw) throw new Error(); url = new URL(raw); }
  catch { throw new Error("격리 DB 시험의 로컬 DATABASE_URL 설정이 필요합니다. 값은 출력하지 않습니다."); }
  // pg는 ?host 및 SSL 파일 옵션을 URL hostname보다 우선한다. 원격/개인 파일 우회를 막기 위해 옵션 전체를 거부한다.
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash) throw new Error("격리 DB 시험은 쿼리·fragment 없는 로컬 PostgreSQL URL만 사용합니다.");
  return url;
}
describe("격리 내구성 DB 연결 사전조건 (연결 없이 검사)", () => {
  it("명시한 로컬 PostgreSQL 주소만 허용한다", () => {
    expect(isolatedDatabaseUrl("postgresql://fixture:fixture@127.0.0.1:5432/fixture").hostname).toBe("127.0.0.1");
    for (const value of [undefined, "not-a-url", "http://localhost/fixture", "postgresql://outside.invalid/fixture"]) expect(() => isolatedDatabaseUrl(value)).toThrow();
  });
  it("실제 pg가 원격 host로 해석하는 query 우회를 연결 전에 거부한다", () => {
    const value = "postgresql://fixture:fixture@127.0.0.1:5432/fixture?host=outside.invalid";
    const client = new Client({ connectionString: value });
    // connect를 호출하지 않고 실제 드라이버의 최종 주소만 확인한다.
    expect((client as unknown as { connectionParameters: { host: string } }).connectionParameters.host).toBe("outside.invalid");
    expect(() => isolatedDatabaseUrl(value)).toThrow();
  });
  it("SSL 파일 옵션과 fragment는 값 노출 없이 거부한다", () => {
    for (const suffix of ["?sslkey=/synthetic/private.key", "?sslrootcert=/synthetic/ca", "#synthetic"]) expect(() => isolatedDatabaseUrl(`postgresql://fixture:fixture@localhost/fixture${suffix}`)).toThrow();
    try { isolatedDatabaseUrl("private-fixture-invalid-url"); } catch (error) { expect(String(error)).not.toContain("private-fixture-invalid-url"); }
  });
});

// 명시적 로컬 시험만 새 DB/T7 fixture를 만든다. 운영 DB 행·workspace·모델·백업은 쓰지 않는다.
describe.skipIf(process.env.AIOS_DURABILITY_TEST !== "1")("실제 새 Postgres DB·T7의 승인/복구 내구성", () => {
  const name = `aios_durability_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let created = false;
  const roots: string[] = [];
  const controllers: AbortController[] = [];
  const operations: Promise<unknown>[] = [];
  beforeAll(async () => {
    const url = isolatedDatabaseUrl(process.env.DATABASE_URL);
    admin = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000 });
    await admin.query(`create database "${name}"`); created = true;
    url.pathname = `/${name}`; pool = new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 3000 });
    await pool.query("create table organizations(id uuid primary key,slug text unique); create table sessions(id uuid primary key,org_id uuid references organizations(id),deleted_at timestamptz)");
    await pool.query(await readFile(new URL("../../../../infra/migrations/0005_execution_safety.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => {
    await pool?.end();
    // 이번 실행에서 CREATE가 성공한 무작위 이름만 제거하며 FORCE/기존 DB 교체는 하지 않는다.
    if (created) await admin.query(`drop database "${name}"`);
    await admin?.end();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await Promise.allSettled(operations.splice(0));
  });
  async function fixture(before: string | null = "before") {
    const base = "/Volumes/T7/bigdata/test-workspaces/execution-durability";
    await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, "case-")); roots.push(root);
    const workspace = join(root, "workspace"); await mkdir(workspace); const store = join(root, "checkpoints");
    const org = randomUUID(), session = randomUUID(), slug = randomUUID();
    await pool.query("insert into organizations values($1,$2)", [org, slug]); await pool.query("insert into sessions(id,org_id) values($1,$2)", [session, org]);
    if (before !== null) await writeFile(join(workspace, "note.txt"), before);
    const tools = new ToolRegistry(); tools.register(writeFileTool);
    const executor = new ToolExecutor(tools, { modes: { read: "auto", write: "confirm", exec: "confirm", net: "deny" }, timeoutMs: 3000 });
    const query = vi.fn(async (sql: string, values?: unknown[]) => pool.query(sql, values));
    const ctx = { env: { LOCAL_WORKSPACE_ROOT: workspace, LOCAL_NO_AUTH_ORG_SLUG: slug }, pool: { query }, tools, executor } as unknown as AppContext;
    const service = new ExecutionService(ctx, 3000, store); const controller = new AbortController(); controllers.push(controller);
    const run = await service.start(org, undefined, session, undefined, controller.signal, () => {});
    const execute = run.execute.bind(run);
    run.execute = (...args) => { const operation = execute(...args); operations.push(operation); void operation.catch(() => {}); return operation; };
    const call = () => ({ id: randomUUID(), name: "write_file", arguments: { path: "note.txt", content: "after" } });
    const pending = async () => { await vi.waitFor(() => expect(service.pending.size).toBe(1)); return [...service.pending.keys()][0]!; };
    const approved = async () => { const operation = run.execute(call()); const id = await pending(); await service.decide(org, session, id, true); expect((await operation).ok).toBe(true); await run.finish(); return id; };
    const status = async (id: string) => (await pool.query("select a.status,a.restored_at,r.status as run_status from execution_actions a join execution_runs r on r.id=a.run_id where a.id=$1", [id])).rows[0];
    return { workspace, ctx, service, run, controller, query, org, session, call, pending, approved, status, store };
  }
  it("동시 중복 승인은 DB에서 단 한 번만 소비되어 실제 파일 쓰기도 한 번이다", async () => {
    const f = await fixture(); const execute = vi.spyOn(f.ctx.executor, "execute");
    const operation = f.run.execute(f.call()); const id = await f.pending();
    const decisions = await Promise.allSettled([f.service.decide(f.org, f.session, id, true), f.service.decide(f.org, f.session, id, true)]);
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect((await operation).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1); expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("after"); await f.run.finish();
  });
  it("DB 승인 응답을 지연시킨 사이 취소되면 뒤늦은 승인이 파일을 쓰지 않는다", async () => {
    const f = await fixture(); const execute = vi.spyOn(f.ctx.executor, "execute");
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
    let entered = false;
    f.query.mockImplementation(async (sql, values) => { const result = await pool.query(sql, values); if (sql.includes("decided_by")) { entered = true; await gate; } return result; });
    const operation = f.run.execute(f.call()); const rejected = expect(operation).rejects.toThrow(); const id = await f.pending();
    const decision = f.service.decide(f.org, f.session, id, true); const late = expect(decision).rejects.toMatchObject({ code: "approval_expired" });
    await vi.waitFor(() => expect(entered).toBe(true)); f.controller.abort(); resume();
    await Promise.all([rejected, late]); expect(execute).not.toHaveBeenCalled(); expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("before"); await f.run.finish();
  });
  it("별도 서비스 인스턴스도 같은 workspace의 승인 대기 동안 복구/쓰기를 시작하지 못한다", async () => {
    const f = await fixture(); const operation = f.run.execute(f.call()); const id = await f.pending();
    const other = new ExecutionService(f.ctx, 3000, f.store);
    await expect(other.withWorkspace(async () => { throw new Error("진입하면 안 됨"); })).rejects.toMatchObject({ code: "workspace_busy" });
    await f.service.decide(f.org, f.session, id, false); expect((await operation).ok).toBe(false); await f.run.finish();
    await expect(other.withWorkspace(async () => "released")).resolves.toBe("released");
  });
  it.each(["existing", "new"])("%s 파일 복구 직후 DB 실패를 주입해도 새 서비스가 원본 해시로 재개한다", async (kind) => {
    const f = await fixture(kind === "new" ? null : "before"); const id = await f.approved(); let injected = false;
    f.query.mockImplementation(async (sql, values) => {
      if (sql.includes("with restored_action") && !injected) { injected = true; throw new Error("synthetic journal unavailable"); }
      return pool.query(sql, values);
    });
    await expect(f.service.restore(f.org, f.session, id)).rejects.toMatchObject({ code: "restore_incomplete" });
    expect(injected).toBe(true); expect(await f.status(id)).toMatchObject({ status: "restoring", restored_at: null, run_status: "unverified" });
    if (kind === "new") await expect(readFile(join(f.workspace, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("before");
    const restarted = new ExecutionService(f.ctx, 3000, f.store);
    expect(await restarted.restore(f.org, f.session, id)).toMatchObject({ ok: true, alreadyRestored: true });
    expect(await f.status(id)).toMatchObject({ status: "restored", run_status: "restored" });
  });
  it("복구 DB commit 뒤 응답만 유실돼도 반복 요청은 현재 원본을 확인하며 다시 쓰지 않는다", async () => {
    const f = await fixture(); const id = await f.approved(); let injected = false;
    f.query.mockImplementation(async (sql, values) => { const result = await pool.query(sql, values); if (sql.includes("with restored_action") && !injected) { injected = true; throw new Error("synthetic lost reply"); } return result; });
    await expect(f.service.restore(f.org, f.session, id)).rejects.toMatchObject({ code: "restore_incomplete" });
    expect(await f.status(id)).toMatchObject({ status: "restored", run_status: "restored" });
    expect(await f.service.restore(f.org, f.session, id)).toMatchObject({ ok: true, alreadyRestored: true });
    await writeFile(join(f.workspace, "note.txt"), "manual edit after recovery");
    await expect(f.service.restore(f.org, f.session, id)).rejects.toMatchObject({ code: "file_conflict" });
    expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("manual edit after recovery");
  });
  it("중단된 복구 재개 전에 제3의 내용으로 변경되면 성공 처리하거나 덮어쓰지 않는다", async () => {
    const f = await fixture(); const id = await f.approved();
    await pool.query("update execution_actions set status='restoring' where id=$1", [id]); await writeFile(join(f.workspace, "note.txt"), "third-party edit");
    await expect(f.service.restore(f.org, f.session, id)).rejects.toMatchObject({ code: "file_conflict" });
    expect(await f.status(id)).toMatchObject({ status: "restore_conflict", restored_at: null }); expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("third-party edit");
  });
  it("동시 복구 요청은 하나만 파일을 바꾸고 다른 요청은 충돌한다", async () => {
    const f = await fixture(); const id = await f.approved();
    const results = await Promise.allSettled([f.service.restore(f.org, f.session, id), f.service.restore(f.org, f.session, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "workspace_busy" } });
    expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("before");
  });
  it("재시작 후 남은 승인은 재사용되지 않고 run/action을 함께 interrupted로 기록한다", async () => {
    const f = await fixture(); const operation = f.run.execute(f.call()); const id = await f.pending();
    f.controller.abort(); await expect(operation).rejects.toThrow();
    // 프로세스 중단 직전의 영속 상태만 재현한다. 실제 사용자 API를 종료하지 않는다.
    await pool.query("update execution_actions set status='approved' where id=$1", [id]);
    const restarted = new ExecutionService(f.ctx, 3000, f.store);
    await expect(restarted.decide(f.org, f.session, id, true)).rejects.toThrow();
    await restarted.list(f.org, f.session);
    expect(await f.status(id)).toMatchObject({ status: "interrupted", run_status: "interrupted" });
    expect(await readFile(join(f.workspace, "note.txt"), "utf8")).toBe("before");
  });
});
