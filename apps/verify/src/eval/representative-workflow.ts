import assert, { AssertionError } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { parseSse } from "@aios/ai";
import { localPersistenceEndpoints } from "./context-persistence-guards.js";

export const WORKFLOW_ROOT = "/Volumes/T7/bigdata/workspaces/my-first-project";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface ReleaseFixture { id: string; code: string; date: string; owner: string }
export const RELEASE_FIXTURES: readonly ReleaseFixture[] = [
  { id: "sky", code: "SKY-2610", date: "2026-10-15", owner: "김하늘" },
  { id: "leaf", code: "LEAF-2611", date: "2026-11-06", owner: "이서준" },
  { id: "wave", code: "WAVE-2612", date: "2026-12-09", owner: "박지우" },
];
export function workflowFixture(runId: string, fixture: ReleaseFixture) {
  assert.match(runId, UUID, "generated run UUID required");
  assert(RELEASE_FIXTURES.some(f => JSON.stringify(f) === JSON.stringify(fixture)), "fixed release fixture required");
  const path = `representative-workflow-${runId}-${fixture.id}.txt`;
  const content = `출시 요약\n제품코드: ${fixture.code}\n출시일: ${fixture.date}\n담당: ${fixture.owner}\n가격: 미정`;
  // 허용 본문은 고정 5줄과 선택적인 마지막 LF뿐이다. 모델이 만든 명령은 실행하지 않는다.
  const allowedContents = [content, content + "\n"];
  const encoded = Buffer.from(JSON.stringify(allowedContents), "utf8").toString("base64");
  const command = `node -e 'const fs=require("node:fs"),a=require("node:assert/strict");const p="${path}";a.ok(fs.lstatSync(p).isFile());const allowed=JSON.parse(Buffer.from("${encoded}","base64").toString("utf8"));a.ok(allowed.includes(fs.readFileSync(p,"utf8")));console.log("RELEASE_SUMMARY_VERIFIED")'`;
  return { ...fixture, path, content, allowedContents, command,
    title: `AIOS 대표 업무 시험 ${runId} ${fixture.id}`,
    referenceName: `release-${fixture.id}-${runId}.txt`,
    referenceContent: `출시 안내 자료\n제품코드: ${fixture.code}\n출시일: ${fixture.date}\n담당: ${fixture.owner}\n가격: 미정\n가격이 결정되지 않았으므로 숫자나 금액을 추측하지 않습니다.\n`,
  };
}
type Fixture = ReturnType<typeof workflowFixture>;
interface Source { id: string; fileName: string; startLine: number; endLine: number }
interface Context { type: "workspace_context"; historyCount: number; sources: Source[]; memory: { enabled: boolean; scannedUserMessages: number; restoredPreferences: { kind: string; value: string }[] } }
interface Action { id: string; run_id: string; tool_name: string; purpose: string; status: string; arguments: Record<string, unknown>; preview: { before: string | null; after: string } | null; before_hash: string | null; after_hash: string | null; checkpoint: boolean; exit_code: number | null; output: string; decided_at: string | null; restored_at: string | null }
interface Run { id: string; org_id: string; session_id: string; workspace_root: string; status: string; verification_command: string | null; actions: Action[] }
export function approveFixtureAction(action: Action, fixture: Fixture, writeAlreadyApproved: boolean): boolean {
  if (!UUID.test(action.id) || !UUID.test(action.run_id) || action.status !== "pending" || !action.arguments || typeof action.arguments !== "object") return false;
  const keys = Object.keys(action.arguments).sort();
  if (action.tool_name === "write_file") return !writeAlreadyApproved && action.purpose === "tool" && JSON.stringify(keys) === '["path"]'
    && action.arguments.path === fixture.path && action.preview?.before === null && fixture.allowedContents.includes(action.preview.after)
    && action.before_hash === null && action.checkpoint === true
    && action.after_hash === createHash("sha256").update(action.preview.after).digest("hex");
  return writeAlreadyApproved && action.tool_name === "run_command" && action.purpose === "verification"
    && JSON.stringify(keys) === '["command","cwd"]' && action.arguments.command === fixture.command && action.arguments.cwd === ".";
}
export function assertReference(context: Context | undefined, fixture: Fixture): Source[] {
  assert(context && context.memory.enabled, "actual saved context required");
  assert(context.historyCount >= 2, "previous preference and answer must be supplied");
  assert(context.memory.scannedUserMessages >= 1 && context.memory.scannedUserMessages <= 500, "bounded preference scan required");
  assert(context.memory.restoredPreferences.some(p => p.kind === "language" && p.value === "ko"), "saved Korean preference must be restored");
  assert(Array.isArray(context.sources) && context.sources.length > 0, "actual source ranges required");
  const lines = fixture.referenceContent.split("\n");
  for (const source of context.sources) {
    assert(source.fileName === fixture.referenceName && Number.isInteger(source.startLine) && Number.isInteger(source.endLine)
      && source.startLine >= 1 && source.endLine >= source.startLine && source.endLine <= lines.length, "source must belong to this fixture and valid lines");
  }
  const supplied = context.sources.map(s => lines.slice(s.startLine - 1, s.endLine).join("\n")).join("\n");
  for (const value of [fixture.code, fixture.date, fixture.owner, "미정"]) assert(supplied.includes(value), "supplied source must contain each release fact");
  return context.sources;
}
export function assertOwnedSession(actual: { id: string; org_id: string; title: string; deleted_at: unknown }, expected: { id: string; orgId: string; title: string }) {
  assert(UUID.test(expected.id) && actual.id === expected.id && actual.org_id === expected.orgId && actual.title === expected.title && actual.deleted_at === null, "only this run's unchanged new session is eligible");
}
async function absent(path: string) {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("fixture target must not already exist");
}

export async function main() {
  assert.equal(process.env.AIOS_REPRESENTATIVE_WORKFLOW_TEST, "1", "AIOS_REPRESENTATIVE_WORKFLOW_TEST=1 required");
  const endpoints = localPersistenceEndpoints({ ...process.env, AIOS_CONTEXT_PERSISTENCE_TEST: "1" });
  assert.equal(endpoints.base, "http://127.0.0.1:8791", "only the local user API on 8791 is allowed");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]) assert(!process.env[key]?.trim(), "paid provider keys must not be present in this test process");
  assert(existsSync("/Volumes/T7/bigdata"), "existing T7 data directory required");
  assert.equal((await realpath(WORKFLOW_ROOT)).normalize("NFC"), WORKFLOW_ROOT, "fixed workspace must not be redirected");
  const pool = new Pool({ connectionString: endpoints.database, max: 2, connectionTimeoutMillis: 3000 });
  const runId = randomUUID();
  const directory = "/Volumes/T7/bigdata/eval-baselines/representative-workflow";
  const output = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${runId}.json`);
  const sourceHash = createHash("sha256").update(await readFile(new URL("./representative-workflow.ts", import.meta.url))).digest("hex");
  const created: { id: string; orgId: string; title: string; verified: boolean }[] = [];
  const results: { fixture: string; pass: boolean; steps: string[]; sessionId?: string; runId?: string; writeActionId?: string; verificationActionId?: string; sources?: Source[]; referenceAnswer?: string; contentHash?: string; readback?: string; verificationExitCode?: number; ms: number; error?: string }[] = [];
  const cleanup: { id: string; trashed: boolean }[] = [];
  let finished = false;
  async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(endpoints.base + path, { method, redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert(response.ok, `workflow API HTTP ${response.status}`);
    return await response.json() as T;
  }
  async function save() { await writeFile(output, JSON.stringify({ schemaVersion: 1, runId, sourceHash, complete: finished, expectedTotal: RELEASE_FIXTURES.length, passed: results.filter(r => r.pass).length, total: results.length,
    scope: "Actual local API, Postgres, local model, approved file write, readonly sandbox verification and checkpoint restore. Fixed release-summary format; not arbitrary task accuracy or another Mac.", created, cleanup, results }, null, 2) + "\n"); }
  async function own(identity: typeof created[number]) {
    const data = await pool.query("select id,org_id,title,deleted_at from sessions where id=$1", [identity.id]);
    assert.equal(data.rowCount, 1, "API-created session must exist in this database");
    assertOwnedSession(data.rows[0], identity);
  }
  async function chat(sessionId: string, prompt: string, fixture?: Fixture) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const response = await fetch(`${endpoints.base}/v1/sessions/${sessionId}/messages`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ content: prompt, mode: "fast", tools: { enabled: !!fixture }, ...(fixture ? { verificationCommand: fixture.command } : {}), context: { useMemory: true, useLongTermMemory: false, useRag: false } }) });
    assert(response.ok && response.body, `workflow chat HTTP ${response.status}`);
    let context: Context | undefined; let text = ""; let done = 0; let model = ""; let runId: string | undefined; let writeActionId: string | undefined;
    const decisions = new Set<string>();
    try {
      for await (const frame of parseSse(response.body)) {
        if (!frame.data) continue;
        const event = JSON.parse(frame.data) as Record<string, unknown>;
        assert(event.type !== "error", "model stream must not contain errors");
        if (event.type === "workspace_context") { assert.equal(text, "", "provenance must precede text"); context = event as unknown as Context; }
        if (event.type === "routed") { assert.equal(event.provider, "local", "only local model routing permitted"); model = String(event.model); }
        if (event.type === "text_delta") text += String(event.text);
        if (event.type === "done") { assert.equal(event.stopReason, "end_turn", "successful final done required"); done++; }
        if (event.type !== "execution_update") continue;
        assert(fixture && typeof event.runId === "string" && UUID.test(event.runId), "execution must belong to the draft turn");
        runId ??= event.runId; assert.equal(event.runId, runId, "one execution run per draft turn");
        const journal = await request<{ runs: Run[] }>(`/v1/sessions/${sessionId}/executions`);
        const run = journal.runs.find(r => r.id === runId);
        assert(run && run.session_id === sessionId && resolve(run.workspace_root).normalize("NFC") === WORKFLOW_ROOT, "execution must stay in its owned workspace");
        assert.equal(run.verification_command, fixture.command, "only fixed verification command permitted");
        for (const action of run.actions) {
          assert.equal(action.run_id, runId, "action must belong to this run");
          if (action.status !== "pending" || decisions.has(action.id)) continue;
          const approve = approveFixtureAction(action, fixture, !!writeActionId);
          // 요청 내용이 다르면 승인하지 않고 거절 기록을 남긴다. 새 파일도 승인 전에는 없어야 한다.
          if (approve && action.tool_name === "write_file") await absent(join(WORKFLOW_ROOT, fixture.path));
          await request(`/v1/sessions/${sessionId}/executions/${action.id}/approval`, { approve }); decisions.add(action.id);
          assert(approve, "unexpected risky proposal rejected; no permissive fallback");
          if (action.tool_name === "write_file") writeActionId = action.id;
        }
      }
      assert.equal(done, 1, "exactly one final done required"); assert.equal(model, "qwen3:8b", "fixed local model required");
      const saved = await request<{ messages: { role: string; content: { text?: string } }[] }>(`/v1/sessions/${sessionId}/messages`);
      assert(saved.messages.some(m => m.role === "user" && m.content.text === prompt), "user request must persist through API reload");
      assert(saved.messages.some(m => m.role === "assistant" && m.content.text === text), "model response must persist through API reload");
      return { text, context, runId, writeActionId };
    } finally { controller.abort(); }
  }
  try {
    await mkdir(directory, { recursive: true }); await writeFile(output, "{}\n", { flag: "wx" });
    const ready = await request<{ ready: boolean }>("/readyz"); assert(ready.ready, "ready API required");
    const me = await request<{ orgId: string; via: string; role: string; workspaceRoot: string }>("/v1/me");
    assert(me.via === "local" && me.role === "owner" && me.workspaceRoot.normalize("NFC") === WORKFLOW_ROOT, "local owner and fixed workspace required");
    const models = await request<{ models: { provider: string; model: string }[] }>("/v1/models");
    assert(models.models.length > 0 && models.models.every(m => m.provider === "local"), "server must expose only local adapters");
    for (const definition of RELEASE_FIXTURES) {
      const fixture = workflowFixture(runId, definition); const started = performance.now();
      const result: typeof results[number] = { fixture: fixture.id, pass: false, steps: [], ms: 0 }; results.push(result);
      let identity: typeof created[number] | undefined;
      try {
        await absent(join(WORKFLOW_ROOT, fixture.path));
        const session = await request<{ id: string }>("/v1/sessions", { title: fixture.title }); assert.match(session.id, UUID);
        identity = { id: session.id, orgId: me.orgId, title: fixture.title, verified: false }; created.push(identity); result.sessionId = session.id; await save();
        await own(identity);
        const empty = await pool.query("select count(*)::int as count from messages where session_id=$1", [session.id]); assert.equal(empty.rows[0].count, 0, "new session must be empty");
        identity.verified = true; result.steps.push("owned-new-session");
        await chat(session.id, "이 대화에서는 답변을 한국어로 해줘."); result.steps.push("saved-language-preference");
        const reference = await request<{ id: string }>(`/v1/sessions/${session.id}/files`, { name: fixture.referenceName, content: fixture.referenceContent, scope: "session" }); assert.match(reference.id, UUID);
        const referenceRow = await pool.query("select id from workspace_files where id=$1 and session_id=$2 and org_id=$3 and name=$4 and content=$5 and deleted_at is null", [reference.id, session.id, me.orgId, fixture.referenceName, fixture.referenceContent]);
        assert.equal(referenceRow.rowCount, 1, "attached reference must be persisted exactly"); result.steps.push("attached-reference-persisted");
        const answer = await chat(session.id, "첨부 자료에서 실제 출시 정보를 찾아주세요. 열 제목이나 항목 이름은 답에 넣지 마세요. 제품코드의 실제 값, 출시일의 실제 값, 담당자의 실제 이름, 가격의 실제 값을 이 순서로 | 기호로 구분한 한 줄로 답해주세요. | 양쪽에 공백을 넣지 마세요. 자료에 미정이라고 적힌 가격은 반드시 미정으로 쓰고 추측하지 마세요.");
        result.sources = assertReference(answer.context, fixture);
        assert.equal(answer.text.trim(), `${fixture.code}|${fixture.date}|${fixture.owner}|미정`, "fixed release facts and unknown field must match");
        result.referenceAnswer = answer.text.trim();
        result.steps.push("reference-answer-and-actual-source-lines");
        const draft = await chat(session.id, `첨부 출시 안내 자료를 바탕으로 짧은 출시 요약 파일을 작성하세요. write_file을 정확히 한 번 사용하여 상대 경로 ${fixture.path}에 UTF-8 텍스트 5줄을 저장하세요. 첫 줄은 출시 요약, 다음 네 줄은 제품코드: 값, 출시일: 값, 담당: 값, 가격: 값 순서입니다. 콜론 뒤 공백은 한 칸입니다. 값은 자료에서 가져오며 미정 항목은 추측하지 마세요. 다른 문장·마크다운·코드블록을 파일에 넣지 마세요. 다른 도구나 명령은 호출하지 마세요. 검증은 시스템에 지정한 읽기 전용 명령으로 따로 확인합니다. 파일 저장 후 짧게 답하세요.`, fixture);
        assertReference(draft.context, fixture); assert(draft.runId && draft.writeActionId, "model must request the approved file write");
        result.runId = draft.runId; result.writeActionId = draft.writeActionId;
        const journal = await request<{ runs: Run[] }>(`/v1/sessions/${session.id}/executions`);
        const run = journal.runs.find(r => r.id === draft.runId); assert(run && run.status === "verified", "run must be verified, not model-only done");
        const writes = run.actions.filter(a => a.tool_name === "write_file"); const checks = run.actions.filter(a => a.purpose === "verification");
        assert.equal(run.actions.length, 2, "one write and one explicit verification only"); assert.equal(writes.length, 1); assert.equal(checks.length, 1);
        assert.equal(writes[0]!.status, "passed"); assert.equal(checks[0]!.status, "passed"); assert.equal(checks[0]!.exit_code, 0);
        assert(checks[0]!.output.includes("RELEASE_SUMMARY_VERIFIED"), "actual readonly assertion output required"); result.verificationActionId = checks[0]!.id;
        result.verificationExitCode = checks[0]!.exit_code;
        result.steps.push("exact-risky-proposal-approved", "readonly-sandbox-exit-zero");
        const file = join(WORKFLOW_ROOT, fixture.path); assert((await lstat(file)).isFile(), "readback must be a regular file");
        const content = await readFile(file, "utf8"); assert(fixture.allowedContents.includes(content), "actual file must match fixed facts and format");
        result.readback = content;
        result.contentHash = createHash("sha256").update(content).digest("hex"); assert.equal(writes[0]!.after_hash, result.contentHash);
        result.steps.push("actual-file-readback-and-hash");
        const restored = await request<{ ok: boolean; removedNewFile: boolean }>(`/v1/sessions/${session.id}/executions/${draft.writeActionId}/restore`, { confirm: true });
        assert(restored.ok && restored.removedNewFile, "restore must remove only the newly created file"); await absent(file);
        const persisted = await pool.query("select a.status,a.restored_at,r.status as run_status from execution_actions a join execution_runs r on r.id=a.run_id join sessions s on s.id=r.session_id where a.id=$1 and r.id=$2 and r.session_id=$3 and r.org_id=$4 and s.title=$5", [draft.writeActionId, draft.runId, session.id, me.orgId, fixture.title]);
        assert.equal(persisted.rowCount, 1); assert(persisted.rows[0].status === "restored" && persisted.rows[0].run_status === "restored" && persisted.rows[0].restored_at, "restore must persist in actual database");
        result.steps.push("api-restore-file-absent-db-journal"); result.pass = true;
      } catch (error) {
        result.error = error instanceof AssertionError ? error.message.split("\n")[0] : "workflow connection or execution failed; no secret/error body recorded";
      } finally {
        // 실패 파일은 임의 삭제하지 않는다. 파일이 없고 작업이 진행 중이지 않을 때만 만든 세션을 정리한다.
        if (identity?.verified) {
          try { await own(identity); await absent(join(WORKFLOW_ROOT, fixture.path));
            const journal = await request<{ runs: Run[] }>(`/v1/sessions/${identity.id}/executions`);
            assert(journal.runs.every(r => r.session_id === identity!.id && r.status !== "running" && r.actions.every(a => !["pending", "approved", "running", "restoring"].includes(a.status))), "unfinished fixture work must remain visible");
            await request(`/v1/sessions/${identity.id}`, { deleted: true }, "PATCH");
            const row = await pool.query("select deleted_at from sessions where id=$1 and org_id=$2 and title=$3", [identity.id, identity.orgId, identity.title]);
            assert.equal(row.rowCount, 1); assert(row.rows[0].deleted_at, "only this fixture must be recoverably trashed"); cleanup.push({ id: identity.id, trashed: true }); result.steps.push("owned-session-in-trash");
          } catch { result.pass = false; result.error = "owned-session cleanup not confirmed"; cleanup.push({ id: identity.id, trashed: false }); }
        } else if (identity) cleanup.push({ id: identity.id, trashed: false });
        result.ms = Math.round(performance.now() - started); await save(); console.log(JSON.stringify({ fixture: result.fixture, pass: result.pass, steps: result.steps.length, ms: result.ms }));
      }
    }
    finished = true;
  } finally {
    await pool.end(); await save();
    if (!finished || results.length !== 3 || results.some(r => !r.pass) || cleanup.length !== 3 || cleanup.some(r => !r.trashed)) process.exitCode = 1;
    console.log(JSON.stringify({ output, passed: results.filter(r => r.pass).length, total: results.length, expectedTotal: 3, recoverableSessionsInTrash: cleanup.filter(r => r.trashed).length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { process.exitCode = 1; console.error("대표 업무 시험 사전조건 또는 저장이 실패했습니다. 환경 값과 외부 오류 본문은 출력하지 않습니다."); });
}
