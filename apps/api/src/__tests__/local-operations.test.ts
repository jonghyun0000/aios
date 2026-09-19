import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiosError, type AuthContext } from "@aios/shared";
import type { AppContext } from "../context.js";
import { readOperationsHistory, registerLocalOperationsRoutes } from "../routes/local-operations.js";

const id = "backup-20260912T010203Z-1234abcd";
const createdAt = "2026-01-01T01:02:03.000Z";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp("/Volumes/T7/bigdata/operations-ui-test-"); roots.push(root);
  const backupRoot = join(root, "backups"); const statusPath = join(root, "backup-status.json");
  await mkdir(join(backupRoot, id), { recursive: true });
  const manifestPath = join(backupRoot, id, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ version: 1, private: "must not appear in API" }));
  const record = { version: 1, lastBackup: { id, createdAt, bytes: 1234, manifestPath }, lastRestoreCheck: { backupId: id, checkedAt: createdAt, status: "passed", restoredDatabase: "aios_restore_check_1234abcd", files: 5 } };
  const save = (value: unknown) => writeFile(statusPath, JSON.stringify(value));
  return { root, statusPath, backupRoot, manifestPath, record, save, read: () => readOperationsHistory(statusPath, backupRoot) };
}

describe("로컬 운영 기록의 실제 파일 결함 주입", () => {
  it("파일이 없거나 이력 필드가 비어 있으면 미실행이며 성공이 아니다", async () => {
    const f = await fixture(); expect(await f.read()).toEqual({ state: "empty" });
    await f.save({ version: 1 }); expect(await f.read()).toEqual({ state: "empty" });
  });
  it("유효한 이력을 읽지만 manifest 경로와 원문은 노출하지 않는다", async () => {
    const f = await fixture(); await f.save(f.record); const result = await f.read();
    expect(result.state).toBe("recorded"); expect(result.lastBackup).toEqual({ id, createdAt, bytes: 1234 });
    expect(result.lastRestoreCheck?.status).toBe("passed");
    expect(JSON.stringify(result)).not.toContain("manifest"); expect(JSON.stringify(result)).not.toContain("must not appear");
    // 결함 주입: 같은 정상 기록에서 실제 manifest를 없애면 성공 상태가 사라져야 한다.
    await rm(f.manifestPath); expect((await f.read()).state).toBe("invalid");
  });
  it.each([
    ["버전 누락", (record: any) => { delete record.version; }],
    ["크기 누락", (record: any) => { delete record.lastBackup.bytes; }],
    ["빈 백업", (record: any) => { record.lastBackup.bytes = 0; }],
    ["잘못된 날짜", (record: any) => { record.lastBackup.createdAt = "not-a-date"; }],
    ["미래 날짜", (record: any) => { record.lastBackup.createdAt = "2999-01-01T00:00:00.000Z"; }],
    ["원본 경로 탈출", (record: any) => { record.lastBackup.manifestPath = "/etc/passwd"; }],
    ["백업 id 탈출", (record: any) => { record.lastBackup.id = "../../secret"; }],
    ["검사 파일 수 누락", (record: any) => { delete record.lastRestoreCheck.files; }],
    ["검사 파일 수 문자열", (record: any) => { record.lastRestoreCheck.files = "5"; }],
    ["음수 검사 파일 수", (record: any) => { record.lastRestoreCheck.files = -1; }],
    ["운영 DB를 격리 DB로 위장", (record: any) => { record.lastRestoreCheck.restoredDatabase = "aios"; }],
    ["잘못된 검사 통과 값", (record: any) => { record.lastRestoreCheck.status = "success"; }],
    ["허용하지 않은 비밀 필드", (record: any) => { record.secret = "do not reveal"; }],
  ])("%s 결함을 실제 상태 파일에 주입하면 성공 기록을 거부한다", async (_name, mutate) => {
    const f = await fixture(); await f.save(f.record); expect((await f.read()).state).toBe("recorded");
    mutate(f.record); await f.save(f.record); const result = await f.read();
    expect(result.state).toBe("invalid"); expect(result.lastBackup).toBeUndefined(); expect(result.lastRestoreCheck).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("do not reveal");
  });
  it("실패한 복원 검사는 통과 기록과 구별하며 검사 산출물 누락을 허용한다", async () => {
    const f = await fixture(); await f.save({ version: 1, lastRestoreCheck: { backupId: id, checkedAt: createdAt, status: "failed" } });
    expect(await f.read()).toEqual({ state: "recorded", lastRestoreCheck: { backupId: id, checkedAt: createdAt, status: "failed" } });
  });
  it("잘린 JSON·과대 파일·읽기 오류는 미실행으로 숨기지 않는다", async () => {
    const f = await fixture(); await writeFile(f.statusPath, '{"version":1,'); expect((await f.read()).state).toBe("invalid");
    await writeFile(f.statusPath, " ".repeat(16 * 1024 + 1)); expect((await f.read()).state).toBe("invalid");
    const result = await readOperationsHistory(join(f.statusPath, "not-a-directory.json"), f.backupRoot);
    expect(result.state).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain(f.root);
  });
});

describe("운영 기록 HTTP 접근 경계", () => {
  async function request(localMode: boolean, via: AuthContext["via"], role: AuthContext["role"], method: "GET" | "POST" = "GET") {
    const app = Fastify();
    app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", scopes: ["*"], via, role }; });
    app.setErrorHandler((err, _, reply) => reply.code(err instanceof AiosError ? err.status : 500).send({ error: (err as Error).message }));
    registerLocalOperationsRoutes(app, { env: { LOCAL_NO_AUTH: localMode } } as unknown as AppContext);
    try { return await app.inject({ method, url: "/v1/local/operations" }); } finally { await app.close(); }
  }
  it.each([[true, "api_key", "owner"], [true, "session", "owner"], [true, "jwt", "owner"], [true, "local", "admin"], [true, "local", "member"], [true, "local", "viewer"], [false, "local", "owner"]] as const)("로컬 모드 %s / %s / %s는 거부한다", async (enabled, via, role) => {
    const res = await request(enabled, via, role); expect(res.statusCode).toBe(403); expect(res.body).not.toContain("/Volumes/");
  });
  it("로컬 owner는 읽기만 가능하며 결과를 캐시하지 않는다", async () => {
    const result = await request(true, "local", "owner");
    expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toMatchObject({ version: 1, mode: "local-read-only", backupRoot: "/Volumes/T7/bigdata/backups/local" });
    expect(result.body).not.toContain("manifestPath");
    expect((await request(true, "local", "owner", "POST")).statusCode).toBe(404);
  });
});
