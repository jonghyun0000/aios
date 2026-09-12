import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireLocalApiOwnership, apiOwnershipPath, processStart } from "../execution/ownership.js";

// 실제 T7 파일/자식 프로세스 검사다. Linux CI의 가짜 PASS로 포함하지 않는다.
describe.skipIf(process.env.AIOS_DURABILITY_TEST !== "1")("작업 폴더 단일 API 소유권 — 실제 독립 프로세스", () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];
  let moduleUrl = "";
  beforeAll(async () => {
    const source = await readFile(fileURLToPath(new URL("../execution/ownership.ts", import.meta.url)), "utf8");
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "node22" });
    moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && !child.signalCode) { const closed = once(child, "exit"); child.send({ stop: true }); await closed; }
    }
    // 독점 생성한 합성 fixture만 정리한다. 운영 workspace/잠금은 이 경로에 없다.
    for (const root of roots.splice(0)) {
      // exFAT의 NFD readdir→재귀 rm 조합은 빈 한글 폴더도 놓친다. 만든 원래 경로로 빈 폴더부터 제거한다.
      await rmdir(join(root, "workspaces", "한글"));
      await rm(root, { recursive: true, force: true });
    }
  });
  async function fixture() {
    const base = "/Volumes/T7/bigdata/test-workspaces/api-ownership";
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "case-")); roots.push(root);
    const workspace = join(root, "workspaces", "한글"); await mkdir(workspace, { recursive: true });
    return { root, ...(await apiOwnershipPath(workspace)) };
  }
  async function child(workspace: string, db: string) {
    const source = `import { createServer } from 'node:http';
      const { acquireLocalApiOwnership } = await import(${JSON.stringify(moduleUrl)});
      try {
        const lease = await acquireLocalApiOwnership(${JSON.stringify(workspace)});
        const server = createServer((req,res)=>res.end('isolated fixture'));
        server.listen(0,'127.0.0.1',()=>process.send({ok:true,port:server.address().port,path:lease.path}));
        process.on('message',m=>{
          if(m.crash) process.exit(91);
          if(m.stop) server.close(()=>{ void lease.release().then(()=>process.exit(0),()=>process.exit(92)); });
        });
      } catch(error) { process.send({ok:false,code:error.code}); process.exitCode=2; }`;
    // 번들된 순수 JS만 실행한다. 시험 자식의 비정상 종료가 tsx/esbuild 고아를 만들지 않는다.
    const proc = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { PATH: process.env.PATH, DATABASE_URL: db }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(proc);
    const result = await Promise.race([
      once(proc, "message").then(([value]) => value as { ok: boolean; code?: string; port?: number; path?: string }),
      once(proc, "exit").then(() => { throw new Error("소유권 시험 자식이 결과 없이 종료됨"); }),
    ]);
    if (!result.ok && proc.exitCode === null) await once(proc, "exit");
    return { proc, result };
  }
  it("서로 다른 DB 설정·임의 포트의 동시 API 3개 중 정확히 하나만 열린다", async () => {
    const f = await fixture();
    const attempts = await Promise.all([1, 2, 3].map((n) => child(f.workspace, `postgres://synthetic/db${n}`)));
    expect(attempts.filter((entry) => entry.result.ok)).toHaveLength(1);
    expect(attempts.filter((entry) => !entry.result.ok).every((entry) => ["local_api_busy", "local_api_lock_unknown"].includes(entry.result.code!))).toBe(true);
    const winner = attempts.find((entry) => entry.result.ok)!;
    expect(await (await fetch(`http://127.0.0.1:${winner.result.port}`)).text()).toBe("isolated fixture");
  });
  it("비정상 exit 뒤 잠금은 남고 새 프로세스가 사망 확인 후 안전하게 회수한다", async () => {
    const f = await fixture(); const first = await child(f.workspace, "postgres://synthetic/first");
    expect(first.result.ok).toBe(true);
    const previous = JSON.parse(await readFile(f.path, "utf8"));
    const exited = once(first.proc, "exit"); first.proc.send({ crash: true }); expect((await exited)[0]).toBe(91);
    expect(JSON.parse(await readFile(f.path, "utf8")).token).toBe(previous.token);
    const second = await child(f.workspace, "postgres://synthetic/second");
    expect(second.result.ok).toBe(true);
    expect(JSON.parse(await readFile(f.path, "utf8")).token).not.toBe(previous.token);
  });
  it("살아 있는 소유권은 나이와 무관하게 차단하고 정상 해제 뒤 재기동한다", async () => {
    const f = await fixture(); const lease = await acquireLocalApiOwnership(f.workspace);
    await expect(acquireLocalApiOwnership(f.workspace)).rejects.toMatchObject({ code: "local_api_busy" });
    await lease.release(); await lease.release();
    const next = await acquireLocalApiOwnership(f.workspace); await next.release();
  });
  it("PID 재사용 표식을 회수하되 그 PID의 실제 프로세스에는 종료 신호를 보내지 않는다", async () => {
    const f = await fixture(); await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, JSON.stringify({ version: 1, workspace: f.workspace.normalize("NFC"), host: hostname(), pid: process.pid, startedAt: "previous process incarnation", token: randomUUID() }));
    const lease = await acquireLocalApiOwnership(f.workspace);
    expect(await processStart(process.pid)).toBeTruthy(); await lease.release();
  });
  it.each(["malformed", "foreign-host", "foreign-workspace"])("%s 잠금을 손대지 않고 실패 폐쇄한다", async (fault) => {
    const f = await fixture(); await mkdir(dirname(f.path), { recursive: true });
    const body = fault === "malformed" ? "{" : JSON.stringify({ version: 1, workspace: fault === "foreign-workspace" ? "/different" : f.workspace.normalize("NFC"), host: fault === "foreign-host" ? "different-machine" : hostname(), pid: 99999999, startedAt: "stale", token: randomUUID() });
    await writeFile(f.path, body);
    await expect(acquireLocalApiOwnership(f.workspace)).rejects.toMatchObject({ code: "local_api_lock_unknown" });
    expect(await readFile(f.path, "utf8")).toBe(body);
  });
  it("소유 토큰이 바뀌면 남의 잠금을 해제하지 않는다", async () => {
    const f = await fixture(); const lease = await acquireLocalApiOwnership(f.workspace);
    const changed = { ...JSON.parse(await readFile(f.path, "utf8")), token: randomUUID() }; await writeFile(f.path, JSON.stringify(changed));
    await expect(lease.release()).rejects.toMatchObject({ code: "local_api_lock_unknown" });
    expect(JSON.parse(await readFile(f.path, "utf8")).token).toBe(changed.token);
  });
  it("유지보수 중 직접 API 기동도 거부하고 유지보수 표식은 보존한다", async () => {
    const f = await fixture(); const maintenance = join(f.root, "run", "local-app", "maintenance.lock"); await mkdir(maintenance, { recursive: true });
    await expect(acquireLocalApiOwnership(f.workspace)).rejects.toMatchObject({ code: "local_api_maintenance" });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(acquireLocalApiOwnership(f.workspace)).rejects.toMatchObject({ code: "local_api_maintenance" });
  });
  it("중단된 회수 잠금은 임의 삭제하지 않는다", async () => {
    const f = await fixture(); await mkdir(`${f.path}.recovery`, { recursive: true });
    const body = JSON.stringify({ version: 1, workspace: f.workspace.normalize("NFC"), host: hostname(), pid: 99999999, startedAt: "dead", token: randomUUID() }); await writeFile(f.path, body);
    await expect(acquireLocalApiOwnership(f.workspace)).rejects.toMatchObject({ code: "local_api_lock_unknown" });
    expect(await readFile(f.path, "utf8")).toBe(body);
  });
  it.each(["run", "local-api", "recovery"])("%s 링크 경로는 대상 파일을 쓰거나 지우기 전에 차단한다", async (linked) => {
    const f = await fixture(); const target = join(f.root, "link-target"); await mkdir(target);
    const sentinel = join(target, "keep.txt"); await writeFile(sentinel, "T7 fixture must stay unchanged");
    // exFAT는 symlink를 만들 수 없다. APFS 필수 임시 예외는 이 독점 디렉터리/잠금 메타데이터/링크에만 쓴다.
    const linkRoot = await realpath(await mkdtemp(join(tmpdir(), "aios-ownership-link-")));
    try {
      const workspace = join(linkRoot, "workspaces/fixture"); await mkdir(workspace, { recursive: true });
      if (linked === "run") await symlink(target, join(linkRoot, "run"));
      else {
        await mkdir(join(linkRoot, "run"));
        if (linked === "local-api") await symlink(target, join(linkRoot, "run/local-api"));
        else {
          const lease = await acquireLocalApiOwnership(workspace);
          await symlink(target, `${lease.path}.recovery`);
          await expect(acquireLocalApiOwnership(workspace)).rejects.toMatchObject({ code: "local_api_lock_unknown" });
          await lease.release();
        }
      }
      if (linked !== "recovery") await expect(acquireLocalApiOwnership(workspace)).rejects.toMatchObject({ code: "local_api_lock_unknown" });
      expect(await readFile(sentinel, "utf8")).toBe("T7 fixture must stay unchanged");
    } finally { await rm(linkRoot, { recursive: true, force: true }); }
  });
});
