import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import Fastify from "fastify";
import { parseSse } from "@aios/ai";
import { ToolExecutor, ToolRegistry, createRunCommandTool, readFileTool, writeFileTool } from "@aios/tools";
import type { AppContext } from "../../../api/src/context.js";
import { ExecutionService, executionService } from "../../../api/src/execution/service.js";
import { registerExecutionRoutes } from "../../../api/src/routes/execution.js";
import { sessionLocks } from "../../../api/src/workspace.js";

// 직접 만든 시험 폴더·대화·승인만 조작한다. 모델이 제안한 임의 작업은 승인하지 않는다.
const base = "http://127.0.0.1:8791";
const stamp = new Date().toISOString().replaceAll(":", "-");
const prefix = `stage3-qa-${randomUUID()}`;
const root = `/Volumes/T7/bigdata/workspaces/my-first-project/${prefix}`;
const store = `/Volumes/T7/bigdata/checkpoints/${prefix}`;
const out = `/Volumes/T7/bigdata/eval-baselines/stage3/execution-${stamp}.json`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const results: { test: string; pass: boolean; detail?: string }[] = [];
const sessions: string[] = [];
const tools = new ToolRegistry(); tools.register(writeFileTool); tools.register(readFileTool); tools.register(createRunCommandTool({ image: process.env.SANDBOX_IMAGE ?? "aios-sandbox:latest", workspaceReadOnly: true }));
const executor = new ToolExecutor(tools, { modes: { read: "auto", write: "confirm", exec: "confirm", net: "deny" }, timeoutMs: 15000 });
const ctx = { pool, tools, executor, env: { LOCAL_WORKSPACE_ROOT: root } } as unknown as AppContext;
const service = executionService(ctx);
const app = Fastify();
const me = await (await fetch(base + "/v1/me")).json() as { orgId: string };
ctx.env.LOCAL_NO_AUTH_ORG_SLUG = (await pool.query("select slug from organizations where id=$1", [me.orgId])).rows[0].slug;
app.addHook("preHandler", async (req) => { req.auth = { orgId: req.headers["x-test-org"] as string || me.orgId, role: req.headers["x-test-role"] === "viewer" ? "viewer" : "owner", scopes: ["*"], via: "local" }; });
app.setErrorHandler((err, _req, reply) => { reply.code((err as { status?: number }).status ?? (err.name === "ZodError" ? 400 : 500)).send({ error: err.message }); });
registerExecutionRoutes(app, ctx);
async function record(test: string, work: () => Promise<void>) {
  try { await work(); results.push({ test, pass: true }); }
  catch (err) { results.push({ test, pass: false, detail: err instanceof Error ? err.stack : String(err) }); }
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(out, JSON.stringify({ complete: false, root, stores: [service.store, store, "/Volumes/T7/bigdata/checkpoints/stage3"], sessions, results }, null, 2));
}
async function session() {
  const id = (await pool.query("insert into sessions(org_id,title) values($1,$2) returning id", [me.orgId, `3단계 안전 검증 ${stamp}`])).rows[0].id as string;
  sessions.push(id); return id;
}
async function start(svc = service) { const id = await session(); const ac = new AbortController(); return { ac, run: await svc.start(me.orgId, undefined, id, undefined, ac.signal, () => {}) }; }
async function pending(svc: ExecutionService) {
  const until = Date.now() + 10000;
  while (!svc.pending.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(svc.pending.size, 1, "expected one pending action"); return [...svc.pending.keys()][0]!;
}
const call = (path: string, content: string) => ({ id: randomUUID(), name: "write_file", arguments: { path, content } });
const absent = async (path: string) => { await assert.rejects(readFile(path), /ENOENT/); };
try {
  await mkdir(root, { recursive: true }); await mkdir("/Volumes/T7/bigdata/eval-baselines/stage3", { recursive: true });
  await record("approval-owner-role-params-replay-and-conflict-restore", async () => {
    const { run } = await start(); await writeFile(join(root, "edit.txt"), "before");
    const operation = run.execute(call("edit.txt", "after")); const id = await pending(service);
    assert.equal(await readFile(join(root, "edit.txt"), "utf8"), "before");
    const url = `/v1/sessions/${run.sessionId}/executions/${id}/approval`;
    assert.equal((await app.inject({ method: "POST", url, headers: { "x-test-org": randomUUID() }, payload: { approve: true } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url, headers: { "x-test-role": "viewer" }, payload: { approve: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, payload: { approve: true, arguments: { path: "hijack" } } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url, payload: { approve: true } })).statusCode, 200);
    assert((await operation).ok); assert.equal(await readFile(join(root, "edit.txt"), "utf8"), "after");
    assert.notEqual((await app.inject({ method: "POST", url, payload: { approve: true } })).statusCode, 200);
    await run.finish();
    const restoreUrl = `/v1/sessions/${run.sessionId}/executions/${id}/restore`;
    sessionLocks(ctx).add(run.sessionId);
    assert.equal((await app.inject({ method: "POST", url: restoreUrl, payload: { confirm: true } })).statusCode, 409);
    sessionLocks(ctx).delete(run.sessionId);
    await writeFile(join(root, "edit.txt"), "manual edit");
    assert.equal((await app.inject({ method: "POST", url: restoreUrl, payload: { confirm: true } })).statusCode, 409);
    assert.equal(await readFile(join(root, "edit.txt"), "utf8"), "manual edit");
    await writeFile(join(root, "edit.txt"), "after");
    assert.equal((await app.inject({ method: "POST", url: restoreUrl, payload: { confirm: true } })).statusCode, 200);
    assert.equal(await readFile(join(root, "edit.txt"), "utf8"), "before");
    assert.equal((await service.list(me.orgId, run.sessionId)).runs[0].actions[0].status, "restored");
  });
  await record("approval-denial-does-not-write", async () => {
    const { run } = await start(); const operation = run.execute(call("denied.txt", "danger")); const id = await pending(service);
    await service.decide(me.orgId, run.sessionId, id, false); assert.equal((await operation).ok, false); await absent(join(root, "denied.txt")); await run.finish();
    assert.equal((await service.list(me.orgId, run.sessionId)).runs[0].status, "failed");
  });
  await record("invalid-tool-arguments-remain-in-journal", async () => {
    const { run } = await start();
    assert.equal((await run.execute({ id: randomUUID(), name: "write_file", arguments: { path: "bad.txt" } })).ok, false);
    await absent(join(root, "bad.txt")); await run.finish();
    assert.equal((await service.list(me.orgId, run.sessionId)).runs[0].actions[0].status, "failed");
  });
  await record("other-organization-cannot-open-shared-host-workspace", async () => {
    const id = await session();
    await assert.rejects(service.start(randomUUID(), undefined, id, undefined, new AbortController().signal, () => {}), /다른 조직/);
  });
  await record("disconnect-cancels-pending-and-release-lock", async () => {
    const { run, ac } = await start(); const operation = run.execute(call("cancelled.txt", "danger")); await pending(service);
    ac.abort(); await assert.rejects(operation); await run.finish(); await absent(join(root, "cancelled.txt"));
    await service.withWorkspace(async () => {}); assert.equal(service.pending.size, 0);
  });
  await record("approval-expiry-fails-closed", async () => {
    const short = new ExecutionService(ctx, 80, store); const { run } = await start(short);
    assert.equal((await run.execute(call("expired.txt", "danger"))).ok, false); await absent(join(root, "expired.txt")); await run.finish();
    assert.equal((await short.list(me.orgId, run.sessionId)).runs[0].actions[0].status, "expired");
  });
  await record("workspace-lock-blocks-other-run", async () => {
    const first = await start(); const operation = first.run.execute(call("locked.txt", "danger")); const id = await pending(service);
    const second = await start(); assert.equal((await second.run.execute(call("other.txt", "danger"))).ok, false); await absent(join(root, "other.txt"));
    await service.decide(me.orgId, first.run.sessionId, id, false); await operation; await first.run.finish(); await second.run.finish();
  });
  await record("sandbox-nonzero-and-read-only-faults", async () => {
    for (const command of ["echo ALL_TESTS_PASSED; exit 42", "echo forbidden > blocked.txt"]) {
      const { run } = await start(); const operation = run.execute({ id: randomUUID(), name: "run_command", arguments: { command, cwd: "." } }); const id = await pending(service);
      await service.decide(me.orgId, run.sessionId, id, true); const result = await operation;
      assert.equal(result.ok, false); assert(result.exitCode !== undefined && result.exitCode !== 0);
      if (command.includes("42")) assert.equal(result.exitCode, 42); else await absent(join(root, "blocked.txt"));
      await run.finish(); assert.equal((await service.list(me.orgId, run.sessionId)).runs[0].status, "failed");
    }
  });
  await record("backup-storage-failure-blocks-write", async () => {
    const blocked = join(root, "not-a-directory"); await writeFile(blocked, "fixture");
    const broken = new ExecutionService(ctx, 100, blocked); const { run } = await start(broken);
    assert.equal((await run.execute(call("unbacked.txt", "danger"))).ok, false); await absent(join(root, "unbacked.txt")); await run.finish();
    assert.equal(broken.pending.size, 0);
  });
  await record("restart-rejects-old-approval-and-recovers-record", async () => {
    const { run, ac } = await start(); const operation = run.execute(call("restart.txt", "danger")); const id = await pending(service);
    const restarted = new ExecutionService(ctx);
    await assert.rejects(restarted.decide(me.orgId, run.sessionId, id, true));
    assert.equal((await restarted.list(me.orgId, run.sessionId)).runs[0].status, "interrupted");
    await absent(join(root, "restart.txt")); ac.abort(); await assert.rejects(operation); await run.finish();
  });
  // 실제 로컬 모델을 거치는 HTTP 승인→쓰기→지정 검증→복구를 3회 반복한다.
  for (let repeat = 1; repeat <= 3; repeat++) await record(`live-model-approved-write-verify-restore-${repeat}`, async () => {
    const id = await session(); const path = `${prefix}/live-${repeat}.txt`; const content = `STAGE3-${repeat}`;
    const command = `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('${path}','utf8'),'${content}')"`;
    const res = await fetch(`${base}/v1/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ content: `Use write_file exactly once to create ${path} with exact content ${content} and no newline. Do not use other tools. Then reply briefly in Korean.`, mode: "fast", tools: { enabled: true }, verificationCommand: command, context: { useMemory: false, useLongTermMemory: false, useRag: false } }) });
    assert(res.ok && res.body, `HTTP ${res.status}`); let doneCount = 0;
    const approved = new Set<string>(); let writeAction: string | undefined;
    for await (const frame of parseSse(res.body)) {
      if (!frame.data) continue; const event = JSON.parse(frame.data);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") { assert.equal(event.stopReason, "end_turn"); doneCount++; }
      if (event.type !== "execution_update") continue;
      const journal = await (await fetch(`${base}/v1/sessions/${id}/executions`)).json();
      for (const action of journal.runs[0].actions) {
        if (action.status !== "pending" || approved.has(action.id)) continue;
        const expected = action.tool_name === "write_file" ? action.arguments.path === path && action.preview.after === content : action.purpose === "verification" && action.arguments.command === command;
        if (action.tool_name === "write_file") { await absent(join(root, `live-${repeat}.txt`)); writeAction = action.id; }
        const decision = await fetch(`${base}/v1/sessions/${id}/executions/${action.id}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: expected }) });
        assert(decision.ok); approved.add(action.id); assert(expected, `unexpected action ${action.tool_name}`);
      }
    }
    assert.equal(doneCount, 1); assert(writeAction); assert.equal(await readFile(join(root, `live-${repeat}.txt`), "utf8"), content);
    const journal = await (await fetch(`${base}/v1/sessions/${id}/executions`)).json();
    assert.equal(journal.runs[0].status, "verified"); assert.equal(journal.runs[0].actions.find((a: { purpose: string }) => a.purpose === "verification").exit_code, 0);
    const restore = await fetch(`${base}/v1/sessions/${id}/executions/${writeAction}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    assert.equal(restore.status, 200); await absent(join(root, `live-${repeat}.txt`));
  });
  // 다른 조직 API 키로 실제 사용자 서버의 기록·복구 접근 차단을 확인한다.
  await record("live-api-tenant-isolation", async () => {
    const foreign = (await pool.query("insert into organizations(name,slug) values($1,$2) returning id", ["Stage3 QA", prefix])).rows[0].id;
    const token = `aios_stage3_${randomUUID()}`;
    const key = (await pool.query("insert into api_keys(org_id,name,key_hash,key_prefix,role,scopes,expires_at) values($1,'Stage3 temporary QA',$2,'stage3','owner',$3,now()+interval '5 minutes') returning id", [foreign, createHash("sha256").update(token).digest("hex"), ["*"]])).rows[0].id;
    try {
      const res = await fetch(`${base}/v1/sessions/${sessions.at(-1)}/executions`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 404); await res.text();
      const foreignSession = await (await fetch(`${base}/v1/sessions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Stage3 foreign workspace denial" }) })).json() as { id: string };
      const attempt = await fetch(`${base}/v1/sessions/${foreignSession.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: "Read the shared workspace", tools: { enabled: true } }) });
      assert.equal(attempt.status, 403); await attempt.text();
    } finally { await pool.query("update api_keys set expires_at=now() where id=$1", [key]); }
  });
} finally {
  await app.close(); await pool.end();
  await writeFile(out, JSON.stringify({ complete: true, root, stores: [service.store, store, "/Volumes/T7/bigdata/checkpoints/stage3"], sessions, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
  console.log(`Report: ${out}`); process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
}
