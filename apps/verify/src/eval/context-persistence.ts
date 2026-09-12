import assert, { AssertionError } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { parseSse } from "@aios/ai";
import { CONTEXT_EVIDENCE_TASKS, type ContextEvidenceTask } from "./context-evidence-tasks.js";
import { localPersistenceEndpoints } from "./context-persistence-guards.js";

// 실제 사용자용 API→Postgres→Redis→Ollama→응답 저장 경로. 새로 만든 합성 세션 ID만 쓴다.
// 기존 대화/자료/파일/설정/모델은 변경하지 않으며 시험 대화는 끝에 휴지통으로 이동한다.
const endpoints = localPersistenceEndpoints(process.env);
if (!existsSync("/Volumes/T7/bigdata")) throw new Error("연결된 T7의 기존 bigdata 폴더가 있어야 합니다. 다른 디스크에 보고서를 만들지 않습니다.");
const pool = new Pool({ connectionString: endpoints.database, max: 2, connectionTimeoutMillis: 3000 });
const redis = new Redis(endpoints.redis, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on("error", () => {}); // 외부 라이브러리 원문 대신 아래 고정 오류로 실패를 보고한다.
const runId = randomUUID();
const directory = "/Volumes/T7/bigdata/eval-baselines/context-persistence";
const output = `${directory}/${new Date().toISOString().replaceAll(":", "-")}-${runId}.json`;
const created: string[] = [];
const verifiedCreated = new Map<string, { orgId: string; title: string }>();
const cleanup: { id: string; trashed: boolean }[] = [];
const results: { id: string; repeat: number; pass: boolean; ms: number; model?: string; text?: string; historyCount?: number; scannedUserMessages?: number; sources?: Source[]; error?: string }[] = [];
const repeats = 3; // 고정 과제·고정 기대값, 한 번 맞은 응답을 성공률로 부르지 않는다.
const suiteHash = createHash("sha256").update(await readFile(new URL("./context-evidence-tasks.ts", import.meta.url))).digest("hex");
interface Source { id: string; fileName: string; startLine: number; endLine: number }
interface ContextEvent { type: "workspace_context"; historyCount: number; sources: Source[]; excerpted: boolean; referenceMode: string;
  memory: { enabled: boolean; historyLimit: number; preferenceScanLimit: number; scannedUserMessages: number; restoredPreferences: { kind: string; value: string }[] } }
type Event = ContextEvent | { type: "text_delta"; text: string } | { type: "done"; stopReason: string } | { type: "error" } | { type: "routed"; provider: string; model: string };
async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(endpoints.base + path, { method, signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`fixture API HTTP ${res.status}`);
  return await res.json() as T;
}
async function save(complete: boolean) {
  await writeFile(output, JSON.stringify({ schemaVersion: 1, runId, complete, suiteHash, repeats,
    scope: "actual local user API, actual DB and Redis, actual local model; only new synthetic sessions; not another Mac or independent backup",
    passed: results.filter(r => r.pass).length, total: results.length, expectedTotal: CONTEXT_EVIDENCE_TASKS.length * repeats,
    created, cleanup, results }, null, 2) + "\n");
}
async function run(task: ContextEvidenceTask, repeat: number, orgId: string) {
  const started = performance.now();
  const title = `AIOS 맥락 통합 시험 ${runId} ${task.id}-${repeat}`;
  const { id } = await request<{ id: string }>("/v1/sessions", { title });
  assert.match(id, /^[a-f0-9-]{36}$/); created.push(id); await save(false);
  // 주소가 다른 DB를 가리키면 이 API가 방금 만든 행이 없으므로 기존 행에 쓰지 않고 중단한다.
  const owned = await pool.query("select s.id, (select count(*)::int from messages m where m.session_id=s.id) as messages from sessions s where s.id=$1 and s.org_id=$2 and s.title=$3 and s.deleted_at is null", [id, orgId, title]);
  assert.equal(owned.rows.length, 1, "new session must belong to the API and this database");
  assert.equal(owned.rows[0].messages, 0, "only an empty newly created session can be seeded");
  verifiedCreated.set(id, { orgId, title });
  const seed = task.history.map((m, position) => ({ role: m.role, text: m.content, position }));
  const inserted = await pool.query(`insert into messages(session_id,role,content,created_at)
    select s.id, f.role::message_role, jsonb_build_object('text',f.text), now()-interval '1 day'+f.position*interval '1 millisecond'
    from sessions s cross join jsonb_to_recordset($4::jsonb) as f(role text,text text,position int)
    where s.id=$1 and s.org_id=$2 and s.title=$3 and s.deleted_at is null`, [id, orgId, title, JSON.stringify(seed)]);
  assert.equal(inserted.rowCount, seed.length, "all fixture history must be persisted in order");
  for (const file of task.files) await request(`/v1/sessions/${id}/files`, { name: file.name, content: file.content, scope: "session" });
  // 지우는 키는 이 실행이 방금 생성·DB에서 확인한 세션에 한정한다.
  await redis.del(`{stm:${id}}:msgs`, `{stm:${id}}:summary`);
  const response = await fetch(`${endpoints.base}/v1/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ content: task.prompt, mode: "fast", tools: { enabled: false }, context: { useMemory: task.useMemory, useLongTermMemory: false, useRag: false } }) });
  assert(response.ok && response.body, `chat HTTP ${response.status}`);
  let text = ""; let done = 0; let context: ContextEvent | undefined; let model: string | undefined;
  for await (const frame of parseSse(response.body)) {
    if (!frame.data) continue;
    const event = JSON.parse(frame.data) as Event;
    if (event.type === "error") throw new Error("fixture model stream error");
    if (event.type === "routed") { assert.equal(event.provider, "local", "local provider only"); model = event.model; }
    if (event.type === "workspace_context") { assert.equal(text, "", "context provenance must precede model text"); context = event; }
    if (event.type === "text_delta") text += event.text;
    if (event.type === "done") { assert.equal(event.stopReason, "end_turn"); done++; }
  }
  assert.equal(done, 1, "one completed terminal response"); assert.equal(model, "qwen3:8b", "same local model as fixed baseline"); assert(context, "actual prepared context must be visible");
  assert.equal(text.trim(), task.expected, "fixed expected answer");
  assert.equal(context.memory.enabled, task.useMemory); assert.equal(context.memory.historyLimit, 100); assert.equal(context.memory.preferenceScanLimit, 500);
  if (!task.useMemory) { assert.equal(context.historyCount, 0); assert.equal(context.memory.scannedUserMessages, 0); assert.deepEqual(context.memory.restoredPreferences, []); }
  if (["short-language", "long-language", "corrected-language"].includes(task.id)) {
    assert(context.memory.restoredPreferences.some(p => p.kind === "language" && p.value === (task.id === "corrected-language" ? "en" : "ko")), "explicit language preference must actually be restored, not guessed");
  }
  if (task.id === "reset-preference") assert.deepEqual(context.memory.restoredPreferences, []);
  if (task.id === "korean-evidence-tail") {
    assert.equal(context.referenceMode, "matched"); assert(context.excerpted);
    const source = context.sources.find(s => s.fileName === task.files[0]!.name && task.files[0]!.content.split("\n").slice(s.startLine - 1, s.endLine).join("\n").includes(task.expected));
    assert(source, "visible file and line range must contain the answer actually supplied");
  }
  if (!task.files.length) assert.deepEqual(context.sources, []);
  const persisted = await request<{ messages: { role: string; content: { text?: string } }[] }>(`/v1/sessions/${id}/messages`);
  assert(persisted.messages.some(m => m.role === "assistant" && m.content.text === text), "response must be saved and reload through actual API");
  const dbAnswer = await pool.query("select m.id from messages m join sessions s on s.id=m.session_id where s.id=$1 and s.org_id=$2 and m.role='assistant' and m.content->>'text'=$3", [id, orgId, text]);
  assert(dbAnswer.rowCount, "response must exist in actual Postgres");
  return { id: task.id, repeat, pass: true, ms: Math.round(performance.now() - started), model, text: text.trim(), historyCount: context.historyCount, scannedUserMessages: context.memory.scannedUserMessages, sources: context.sources };
}
try {
  await mkdir(directory, { recursive: true }); await writeFile(output, "{}\n", { flag: "wx" });
  const me = await request<{ orgId: string; via: string }>("/v1/me"); assert.equal(me.via, "local");
  const available = await request<{ models: { model: string; provider: string }[] }>("/v1/models");
  assert(available.models.length > 0 && available.models.every(m => m.provider === "local"), "only local model adapters may be enabled for this test");
  await redis.connect();
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of CONTEXT_EVIDENCE_TASKS) {
    const start = performance.now();
    try { results.push(await run(task, repeat, me.orgId)); }
    catch (error) { results.push({ id: task.id, repeat, pass: false, ms: Math.round(performance.now() - start), error: error instanceof AssertionError ? error.message.split("\n")[0] : "fixture connection or execution failed; no environment/error body recorded" }); }
    await save(false); const latest = results.at(-1)!; console.log(JSON.stringify({ id: latest.id, repeat, pass: latest.pass, ms: latest.ms }));
    // 같은 실패를 무한 재시도하지 않는다. 실패가 난 과제도 다음 고정 회차와 별개로 기록한다.
  }
} catch {
  process.exitCode = 1; console.error("맥락 통합 시험 사전조건 또는 실행이 실패했습니다. 연결 설정·서비스 상태를 확인하세요. 비밀 값은 출력하지 않습니다.");
} finally {
  for (const id of created) {
    try {
      const identity = verifiedCreated.get(id);
      assert(identity, "unverified API-returned IDs must never be cleaned up");
      const own = await pool.query("select id from sessions where id=$1 and org_id=$2 and title=$3 and deleted_at is null", [id, identity.orgId, identity.title]);
      assert.equal(own.rowCount, 1, "do not trash a fixture renamed or moved by somebody else");
      await request(`/v1/sessions/${id}`, { deleted: true }, "PATCH"); cleanup.push({ id, trashed: true });
    }
    catch { cleanup.push({ id, trashed: false }); process.exitCode = 1; }
  }
  redis.disconnect(); await pool.end();
  const complete = results.length === CONTEXT_EVIDENCE_TASKS.length * repeats;
  if (!complete || results.some(r => !r.pass) || cleanup.some(r => !r.trashed)) process.exitCode = 1;
  await save(complete);
  console.log(JSON.stringify({ output, passed: results.filter(r => r.pass).length, total: results.length, expectedTotal: CONTEXT_EVIDENCE_TASKS.length * repeats, recoverableTestSessionsInTrash: cleanup.filter(r => r.trashed).length }));
}
