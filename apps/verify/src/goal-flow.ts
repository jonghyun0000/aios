import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppContext } from "../../api/src/context.js";
import { executionService } from "../../api/src/execution/service.js";
import { wilson } from "./eval/stats.js";

interface Action { id: string; status: string; tool_name: string; purpose: string; arguments: { path?: string; content?: string }; before_hash: string | null; after_hash: string | null; exit_code: number | null; output: string; checkpoint: boolean }
interface Run { id: string; status: string; goal: string; verification_command: string; resumed_from: string | null; actions: Action[] }

// CI와 같은 격리 DB·소유권·정리 경계를 재사용한다. 외부 키나 운영 대화를 사용하지 않는다.
export async function verifyGoalFlow(ctx: AppContext, base: string, sessions: string[]) {
  assert(process.env.AIOS_CI_GOAL_FLOW === "1");
  const service = executionService(ctx);
  const json = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const list = async (id: string): Promise<Run[]> => (await json(`/v1/sessions/${id}/executions`) as { runs: Run[] }).runs;
  const browser = async (fixture?: { session: string; goal: string }) => {
    // Playwright 결과만 APFS 예외. 바이너리·실제 시험 데이터는 T7에 둔다.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "chat-goal-flow.spec.ts", "chat-stage3.spec.ts"], {
        cwd: join(process.cwd(), "apps/web"), stdio: "inherit",
        env: { ...process.env, TMPDIR: "/tmp", AIOS_BASE_URL: base, ...(fixture ? { AIOS_GOAL_FLOW_FIXTURE: JSON.stringify(fixture) } : {}) },
      });
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`goal browser exit ${code}`)));
    });
  };
  await browser();
  const observations: Array<{ completed: boolean; duplicateApprovals: number; seconds: number }> = [];
  let fixture: { session: string; goal: string } | undefined;
  for (let i = 1; i <= 3; i++) {
    const session = (await json("/v1/sessions", { title: `격리 목표 이어서 하기 ${i}` }) as { id: string }).id;
    sessions.push(session);
    const file = `resume-sum-${i}.js`;
    const goal = `${file} 파일에 console.log(55); 한 줄을 저장해줘. 파일을 실제로 만들어야 해.`;
    const command = `node ${file}`;
    const started = Date.now();
    const turn = async (resume?: string): Promise<Run> => {
      const controller = new AbortController();
      const response = await fetch(`${base}/v1/sessions/${session}/messages`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ content: resume ? `이전 목표를 이어서 마무리해줘. ${file}은 이미 저장했으니 내용을 확인하고 불필요하게 다시 쓰지 마.` : goal,
          verificationCommand: command, ...(resume ? { resumeRunId: resume } : {}), mode: "fast", routing: { model: "qwen3:8b", reasoning: "off" }, tools: { enabled: true }, context: { useMemory: false, useLongTermMemory: false, useRag: false } }) });
      assert.equal(response.status, 200);
      let streamDone = false; let streamText = "";
      const reading = response.text().then((text) => { streamText = text; }).catch((error: unknown) => { if (!controller.signal.aborted) throw error; }).finally(() => { streamDone = true; });
      void reading.catch(() => {});
      const decided = new Set<string>();
      let duplicateApprovals = 0; let found: Run | undefined;
      try {
        for (let poll = 0; poll < 1800; poll++) {
          const runs = await list(session); found = runs.find((run) => resume ? run.resumed_from === resume : !run.resumed_from);
          if (found) {
            if (!resume && found.actions.some((a) => a.tool_name === "write_file" && a.status === "passed")) controller.abort();
            if (!controller.signal.aborted) for (const action of found.actions.filter((a) => a.status === "pending" && !decided.has(a.id))) {
              if (action.tool_name === "write_file" && action.before_hash !== null && action.before_hash === action.after_hash) duplicateApprovals++;
              decided.add(action.id); await json(`/v1/sessions/${session}/executions/${action.id}/approval`, { approve: true });
            }
            if (found.status !== "running" && streamDone) break;
          }
          await delay(100);
        }
        assert(found && found.status !== "running", "turn never completed");
        if (!resume) { assert.equal(found.status, "cancelled"); assert(found.actions.some((a) => a.tool_name === "write_file" && a.status === "passed")); }
        else {
          assert(!streamText.includes('"type":"error"'), streamText);
          assert.equal(found.goal, goal); assert.equal(found.resumed_from, resume);
          assert(found.actions.some((a) => a.purpose === "verification" && a.exit_code === 0 && /55/.test(a.output)), "verification output missing");
          observations.push({ completed: found.status === "verified", duplicateApprovals, seconds: (Date.now() - started) / 1000 });
        }
        return found;
      } finally { controller.abort(); await reading; }
    };
    const original = await turn();
    await turn(original.id);
    fixture = { session, goal };
    console.log(`GOAL_OBSERVATION ${JSON.stringify(observations.at(-1))}`);
    // 모델이 같은 쓰기를 제안하지 않아도 무쓰기 분기는 실제 파일·DB에서 별도로 확인한다.
    const org = (await ctx.pool.query("select org_id from sessions where id=$1", [session])).rows[0].org_id as string;
    const before = await stat(join(service.root, file)); const content = await readFile(join(service.root, file), "utf8");
    const noop = await service.start(org, undefined, session, undefined, new AbortController().signal, () => {}, { goal: "같은 내용 무쓰기 확인" });
    assert((await noop.execute({ id: randomUUID(), name: "write_file", arguments: { path: file, content } })).ok);
    await noop.finish();
    const row = (await list(session)).find((run) => run.id === noop.id)!;
    assert.equal(row.status, "unverified"); assert.equal(row.actions[0]!.status, "unchanged"); assert.equal(row.actions[0]!.checkpoint, false);
    assert.equal((await stat(join(service.root, file))).mtimeMs, before.mtimeMs);
    await assert.rejects(service.prepareResume(org, session, original.id), { code: "already_resumed" });
  }
  assert.equal(observations.length, 3); assert(observations.every((o) => o.completed && o.duplicateApprovals === 0));
  await browser(fixture);
  console.log(`GOAL_FLOW_PASS ${JSON.stringify({ observations, completed95: wilson(3, 3), duplicateApprovals: 0 })}`);
}
