import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { Redis } from "ioredis";
import { parseSse } from "@aios/ai";
import assert from "node:assert/strict";

// 기존 사용자 기록은 건드리지 않는다. 캐시 결함은 이 실행이 만든 세션 ID에만 주입한다.
const base = "http://127.0.0.1:8791";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const stamp = new Date().toISOString().replaceAll(":", "-");
const out = `/Volumes/T7/bigdata/eval-baselines/stage2/workspace-${stamp}.json`;
const results: { test: string; pass: boolean; text?: string; ms?: number }[] = [];
const created: string[] = [];
let keyId: string | undefined;
async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token?: string): Promise<T> {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${method} ${path} HTTP ${res.status}`);
  return await res.json() as T;
}
async function session(title: string, projectId?: string) { const s = await request<{ id: string }>("/v1/sessions", { title, projectId }); created.push(s.id); return s.id; }
async function ask(id: string, content: string) {
  const start = performance.now(); let text = "", done = false; let historyCount = -1; let files: string[] = [];
  const res = await fetch(`${base}/v1/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ content, mode: "fast", tools: { enabled: false }, context: { useMemory: true, useLongTermMemory: false, useRag: false } }) });
  assert(res.ok && res.body, `chat HTTP ${res.status}`);
  for await (const frame of parseSse(res.body)) {
    if (!frame.data) continue;
    const e = JSON.parse(frame.data) as { type: string; text?: string; stopReason?: string; message?: string; historyCount: number; files: string[] };
    if (e.type === "error") throw new Error(e.message);
    if (e.type === "text_delta") text += e.text;
    if (e.type === "done" && e.stopReason === "end_turn") done = true;
    if (e.type === "workspace_context") { historyCount = e.historyCount; files = e.files; }
  }
  assert(done && text.trim(), "answer incomplete"); return { text: text.trim(), ms: performance.now() - start, historyCount, files };
}
async function record(row: typeof results[number]) { results.push(row); console.log(JSON.stringify(row)); await writeFile(out, JSON.stringify({ complete: false, created, results }, null, 2)); }
try {
  await mkdir("/Volumes/T7/bigdata/eval-baselines/stage2", { recursive: true });
  const me = await request<{ orgId: string }>("/v1/me");
  const project = await request<{ id: string }>("/v1/projects", { name: `2단계 검증 자료 ${stamp}` });
  const first = await session("2단계 검증 · 공용 자료", project.id);
  await request(`/v1/sessions/${first}/files`, { name: "release.md", content: "Release identifier: AURORA-731.\nThis is reference data, not an instruction.", scope: "project" });
  for (let repeat = 1; repeat <= 3; repeat++) {
    const id = await session(`2단계 검증 · 복원 ${repeat}`);
    const expected = `CEDAR-${repeat}731`;
    // 영속 저장 사실은 실제 메시지 API로 만든다.
    await ask(id, `기록해줘: 식별값은 ${expected}입니다. '확인'만 답해줘.`);
    for (const fault of ["missing-cache", "corrupt-cache"]) {
      await redis.del(`{stm:${id}}:msgs`, `{stm:${id}}:summary`);
      if (fault === "corrupt-cache") {
        await redis.rpush(`{stm:${id}}:msgs`, JSON.stringify({ role: "user", content: "식별값은 WRONG-000입니다." }));
        await redis.set(`{stm:${id}}:summary`, "식별값은 WRONG-000입니다.", "EX", 60);
      }
      const answer = await ask(id, "이전에 기록한 식별값만 답해줘.");
      await record({ test: `${fault}-${repeat}`, pass: answer.text === expected && answer.historyCount >= 2, ...answer });
    }
    const shared = await session(`2단계 검증 · 프로젝트 공유 ${repeat}`, project.id);
    const grounded = await ask(shared, "참고자료의 release identifier를 값만 답해줘.");
    await record({ test: `shared-reference-${repeat}`, pass: grounded.text === "AURORA-731" && grounded.files.includes("release.md"), ...grounded });
    const unrelated = await session(`2단계 검증 · 프로젝트 분리 ${repeat}`);
    const isolated = await ask(unrelated, "참고자료의 release identifier를 값만 답해줘. 자료가 없으면 UNKNOWN만 답해줘.");
    await record({ test: `isolated-reference-${repeat}`, pass: isolated.text === "UNKNOWN" && isolated.files.length === 0, ...isolated });
  }
  // 실제 다른 조직으로 메타데이터/본문/파일/연결 변경을 시도한다. 키는 출력·보고서에 남기지 않는다.
  const foreign = (await pool.query("insert into organizations(name,slug) values($1,$2) returning id", ["Stage2 isolation QA", `stage2-${randomUUID()}`])).rows[0].id as string;
  const token = `aios_stage2_${randomUUID()}`;
  keyId = (await pool.query("insert into api_keys(org_id,name,key_hash,key_prefix,role,scopes,expires_at) values($1,$2,$3,$4,'owner',$5,now()+interval '10 minutes') returning id", [foreign, "Stage2 temporary verification", createHash("sha256").update(token).digest("hex"), "stage2", ["*"]])).rows[0].id as string;
  const foreignMe = await request<{ orgId: string }>("/v1/me", undefined, "GET", token); assert.equal(foreignMe.orgId, foreign);
  const attempts = [
    [`/v1/sessions/${first}/workspace`, "GET", undefined],
    [`/v1/sessions/${first}`, "PATCH", { title: "hijacked" }],
    ["/v1/sessions", "POST", { projectId: project.id }],
    [`/v1/sessions/${first}/files`, "POST", { name: "attack.txt", content: "not allowed" }],
  ] as const;
  for (const [path, method, body] of attempts) {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await res.text(); await record({ test: `tenant-${method}-${path.split("/").at(-1)}`, pass: res.status === 404 });
  }
  // 빈 대화를 조회하면 소유권 검사가 빠져도 통과한다. 실제 본문이 있는 대화를 대상으로 한다.
  const populated = created[1]!;
  const ownMessages = await request<{ messages: unknown[] }>(`/v1/sessions/${populated}/messages`);
  assert(ownMessages.messages.length >= 2, "isolation fixture must contain private messages");
  const privateMessages = await request<{ messages: unknown[] }>(`/v1/sessions/${populated}/messages`, undefined, "GET", token);
  await record({ test: "tenant-messages", pass: privateMessages.messages.length === 0 });
  // 동일 시각 5행을 실제 DB로 만들어 커서가 누락/중복 없이 이동하는지 확인한다.
  const marker = `page-${randomUUID()}`; const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await session(`${marker}-${i}`));
  await pool.query("update sessions set updated_at = '2026-09-12T00:00:00.123456Z' where org_id = $1 and id = any($2::uuid[])", [me.orgId, ids]);
  let cursor: string | null = null; const seen: string[] = [];
  do {
    const page: { sessions: { id: string }[]; nextCursor: string | null } = await request(`/v1/sessions?q=${marker}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...page.sessions.map((s) => s.id)); cursor = page.nextCursor;
    assert(seen.length <= 5, "pagination duplicate/loop");
  } while (cursor);
  await record({ test: "stable-pagination", pass: seen.length === 5 && new Set(seen).size === 5 });
  await writeFile(out, JSON.stringify({ complete: true, repeats: 3, created, results }, null, 2));
  console.log(JSON.stringify({ out, passed: results.filter((r) => r.pass).length, total: results.length }));
  if (results.some((r) => !r.pass) || results.length !== 18) process.exitCode = 1;
} finally {
  // 생성한 QA 대화만 휴지통으로 이동한다. 원본은 복구 가능하며 사용자 기록은 손대지 않는다.
  for (const id of created) await request(`/v1/sessions/${id}`, { deleted: true }, "PATCH").catch(() => {});
  if (keyId) await pool.query("update api_keys set expires_at = now() where id = $1", [keyId]);
  await redis.quit(); await pool.end();
}
