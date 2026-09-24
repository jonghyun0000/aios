import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createContext } from "../../api/src/context.js";
import { buildServer } from "../../api/src/server.js";
import { executionService } from "../../api/src/execution/service.js";
import { acquireLocalApiOwnership } from "../../api/src/execution/ownership.js";
import { createQueues } from "../../api/src/queue.js";
import { wilson } from "./eval/stats.js";

// 이 진입점도 단독으로 운영 설정에 실행되지 않게 격리 DB와 작업 폴더 형식을 확인한다.
const database = new URL(process.env.DATABASE_URL!);
assert(/^\/aios_ci_[0-9a-f]{32}$/.test(database.pathname));
assert(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) && !database.search);
assert(/\/aios-ci-[^/]+\/(fault|normal)\/workspaces\/fixture$/.test(process.env.LOCAL_WORKSPACE_ROOT || ""));
const ctx = await createContext();
const sessions: string[] = [];
const abort = new AbortController();
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let ownership: Awaited<ReturnType<typeof acquireLocalApiOwnership>> | undefined;
try {
  // 서비스가 필요한 표를 실제 질의한다. 파일명만 검사하면 적용 누락을 잡지 못한다.
  try { await ctx.pool.query("select id,after_hash from execution_actions limit 0"); }
  catch (error) { if ((error as { code?: string }).code === "42P01") throw new Error("CI_SCHEMA_MISSING:42P01"); throw error; }
  ownership = await acquireLocalApiOwnership(ctx.env.LOCAL_WORKSPACE_ROOT!);
  app = await buildServer(ctx);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  async function request(path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(res.status, 200, `${path}: HTTP ${res.status}`);
    return res;
  }
  await request("/readyz");
  for (let i = 0; i < 3; i++) {
    const { id } = await (await request("/v1/sessions", { title: `CI ${i}` })).json() as { id: string };
    assert.match(id, /^[0-9a-f-]{36}$/); sessions.push(id);
    const res = await request(`/v1/sessions/${id}/messages`, {
      content: "Say hello in one short sentence.", mode: "fast", tools: { enabled: false },
      routing: { reasoning: "off" },
      context: { useMemory: false, useLongTermMemory: false, useRag: false },
    });
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const events = (await res.text()).split("\n").filter((s) => s.startsWith("data: ")).map((s) => JSON.parse(s.slice(6)) as { type: string; text?: string; stopReason?: string });
    assert(!events.some((e) => e.type === "error"));
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    assert(text.trim().length > 0, "model returned no text");
    const done = events.filter((e) => e.type === "done");
    assert.equal(done.length, 1); assert.notEqual(done[0]!.stopReason, "error");
    const saved = await ctx.pool.query("select role,content from messages where session_id=$1 order by created_at,id", [id]);
    assert.equal(saved.rows.length, 2);
    assert(saved.rows.some((m: { role: string; content: { text: string } }) => m.role === "assistant" && m.content.text === text));
    const cached = await ctx.redis.lrange(`{stm:${id}}:msgs`, 0, -1);
    assert.equal(cached.length, 2);
    assert(cached.some((m) => JSON.parse(m).role === "assistant" && JSON.parse(m).content === text));
    console.log(`PASS real chat ${i + 1}/3: SSE, Postgres, Redis`);
  }
  const vectors = await ctx.router.embed(["CI integration fixture"]);
  assert.equal(vectors.length, 1); assert.equal(vectors[0]!.length, 1024);
  assert(vectors[0]!.every(Number.isFinite));
  const vector = `[${vectors[0]!.join(",")}]`;
  const stored = await ctx.pool.query("select vector_dims($1::vector(1024)) as dims, ($1::vector(1024) <=> $1::vector(1024)) as distance", [vector]);
  assert.equal(stored.rows[0].dims, 1024); assert(Math.abs(Number(stored.rows[0].distance)) < 0.00001);
  console.log("PASS real embedding 1024 + pgvector roundtrip");

  const session = sessions[0]!;
  const org = (await ctx.pool.query("select org_id from sessions where id=$1", [session])).rows[0].org_id as string;
  const service = executionService(ctx);
  const file = join(service.root, "approved.txt"); await writeFile(file, "before\n");
  const run = await service.start(org, undefined, session, undefined, abort.signal, () => {});
  // 모델의 도구 선택을 고정하되 승인·실행·저장·복구는 제품 구현을 그대로 쓴다.
  const operation = run.execute({ id: randomUUID(), name: "write_file", arguments: { path: "approved.txt", content: "after\n" } });
  void operation.catch(() => {});
  let actionId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const list = await (await request(`/v1/sessions/${session}/executions`)).json() as { runs: { actions: { id: string; status: string }[] }[] };
    actionId = list.runs.flatMap((r) => r.actions).find((a) => a.status === "pending")?.id;
    if (actionId) break;
    await delay(50);
  }
  assert(actionId, "approval did not become pending");
  assert.equal(await readFile(file, "utf8"), "before\n");
  await request(`/v1/sessions/${session}/executions/${actionId}/approval`, { approve: true });
  assert.equal((await operation).ok, true); await run.finish();
  const row = (await ctx.pool.query("select status,after_hash from execution_actions where id=$1", [actionId])).rows[0];
  assert.equal(row.status, "passed"); assert.equal(row.after_hash, hash("after\n"));
  assert.equal(hash(await readFile(file)), row.after_hash);
  const duplicate = await fetch(`${base}/v1/sessions/${session}/executions/${actionId}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"approve":true}', signal: AbortSignal.timeout(5000) });
  assert([404, 409].includes(duplicate.status)); await duplicate.text();
  await request(`/v1/sessions/${session}/executions/${actionId}/restore`, { confirm: true });
  assert.equal(await readFile(file, "utf8"), "before\n");
  assert.equal((await ctx.pool.query("select status from execution_actions where id=$1", [actionId])).rows[0].status, "restored");
  console.log("PASS approval, readback SHA-256, duplicate rejection, restore");
  console.log(JSON.stringify({ result: "PASS", model: ctx.env.LOCAL_LLM_MODELS, chat: { passed: 3, total: 3, wilson95: wilson(3, 3) } }));
} finally {
  abort.abort();
  await Promise.allSettled([...executionService(ctx).active.values()].map((run) => run.finish()));
  await app?.close();
  // API가 만든 지연 메모리 잡·이벤트도 이 실행의 session ID로만 정리한다.
  const queues = sessions.length ? createQueues(ctx) : undefined;
  for (const id of sessions) {
    await ctx.redis.del(`{stm:${id}}:msgs`, `{stm:${id}}:summary`);
    await (await queues!.memory.getJob(`mem-${id}`))?.remove();
  }
  await queues?.memory.close(); await queues?.index.close();
  const events = await ctx.redis.xrange("aios:events", "-", "+");
  for (const [id, fields] of events) {
    const entry = JSON.parse(fields[fields.indexOf("event") + 1] || "null") as { payload?: { sessionId?: string }; orgId?: string } | null;
    if (!entry?.payload?.sessionId || !sessions.includes(entry.payload.sessionId)) continue;
    await ctx.redis.xdel("aios:events", id);
    if (entry.orgId) {
      const date = new Date();
      await ctx.redis.del(`usage:${entry.orgId}:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
    }
  }
  await ctx.close();
  await ownership?.release();
}
// 제품 main과 같은 종료 방식: 닫기 훅·DB·소유권 해제 성공 후 프로세스를 끝낸다.
// 레거시 WS의 Redis 구독 연결은 자연 종료되지 않으므로 이 검사를 자연 종료 검증으로 주장하지 않는다.
process.exit(0);
