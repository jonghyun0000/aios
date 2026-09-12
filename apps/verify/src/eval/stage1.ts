import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AiRouter, LocalAdapter, localModels } from "@aios/ai";
import type { AgentEvent, ChatMessage, ChatMode } from "@aios/shared";
import { AgentOrchestrator } from "../../../api/src/agent/orchestrator.js";
import type { AppContext } from "../../../api/src/context.js";
import { STAGE_TASKS, type StageTask } from "./stage1-tasks.js";

// 실제 정책→오케스트레이터→라우터→로컬 모델. 저장/검색은 고정된 메모리 픽스처로 격리한다.
// 사용자 대화 목록을 300개 평가 세션으로 채우지 않는다. DB/Redis/SSE는 별도 API 시험으로 검증.
const model = process.env.LOCAL_LLM_MODELS?.split(",")[0] ?? "qwen3:8b";
const base = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1";
const adapter = new LocalAdapter(base, "bge-m3", undefined, 4, 1, "ollama", 8192);
const repeats = Math.max(3, Number(process.env.REPEATS) || 3);
const stamp = new Date().toISOString().replaceAll(":", "-");
const dir = "/Volumes/T7/bigdata/eval-baselines/stage1";
await mkdir(dir, { recursive: true });
const file = `${dir}/paired-${stamp}.json`;
const tasks = process.env.STAGE_FILTER ? STAGE_TASKS.filter((t) => t.id.includes(process.env.STAGE_FILTER!)) : STAGE_TASKS;
const suiteHash = createHash("sha256").update(await readFile(new URL("./stage1-tasks.ts", import.meta.url))).update(await readFile(new URL("./tasks.ts", import.meta.url))).digest("hex");
type Result = { id: string; category: string; mode: ChatMode; repeat: number; pass: boolean; text: string; error?: string; firstTextMs: number | null; totalMs: number; events: AgentEvent[] };
const results: Result[] = [];
async function run(task: StageTask, mode: ChatMode, repeat: number): Promise<Result> {
  const history: ChatMessage[] = [...(task.history ?? [])];
  const agent = new AgentOrchestrator({
    env: { LOCAL_LLM_BASE_URL: base, LOCAL_LLM_CONTEXT: 8192 },
    pool: { query: async () => ({ rows: [] }) },
    memory: { record: async (_id: string, m: ChatMessage) => { history.push(m); }, buildContext: async () => ({ history: [...history], stmSummary: null, facts: [] }) },
    retriever: { format: () => [] }, bus: { publish: async () => {} },
    router: new AiRouter({ local: adapter }, { catalog: localModels([model], 8192) }),
  } as unknown as AppContext);
  const started = performance.now(); let text = ""; let firstTextMs: number | null = null; let done = false; let error: string | undefined;
  const events: AgentEvent[] = [];
  try {
    for await (const event of agent.run({ orgId: "stage1-eval", sessionId: "isolated", content: task.prompt, mode, toolsEnabled: false, useMemory: true, useRag: false, signal: AbortSignal.timeout(180_000) })) {
      if (event.type === "text_delta") { firstTextMs ??= performance.now() - started; text += event.text; }
      else events.push(event);
      if (event.type === "done") done = event.stopReason === "end_turn";
      if (event.type === "error") error = event.message;
    }
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  return { id: task.id, category: task.category, mode, repeat, text, events, firstTextMs, totalMs: performance.now() - started, error, pass: done && !error && task.check(text) };
}
console.log(JSON.stringify({ file, tasks: tasks.length, repeats, suiteHash, scope: "real engine; isolated memory; no live database" }));
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const [index, task] of tasks.entries()) {
    // 캐시/발열 순서 효과를 줄이도록 쌍마다 선행 모드를 바꾼다.
    const modes: ChatMode[] = (index + repeat) % 2 ? ["fast", "auto"] : ["auto", "fast"];
    for (const mode of modes) {
      const result = await run(task, mode, repeat); results.push(result);
      await writeFile(file, JSON.stringify({ model, contextWindow: 8192, protocol: "ollama", suiteHash, tasks: tasks.map(({ id, category, prompt, history }) => ({ id, category, prompt, history })), repeats, complete: false, results }, null, 2));
      console.log(JSON.stringify({ n: results.length, id: task.id, mode, repeat, pass: result.pass, totalMs: Math.round(result.totalMs), failure: result.pass ? undefined : result.text.slice(0, 140) || result.error }));
    }
  }
}
const summaries = ["fast", "auto"].map((mode) => {
  const rows = results.filter((r) => r.mode === mode); const times = rows.map((r) => r.totalMs).sort((a, b) => a - b);
  return { mode, passed: rows.filter((r) => r.pass).length, n: rows.length, medianTotalMs: times[Math.floor(times.length / 2)], p95TotalMs: times[Math.ceil(times.length * .95) - 1] };
});
await writeFile(file, JSON.stringify({ model, contextWindow: 8192, protocol: "ollama", suiteHash, tasks: tasks.map(({ id, category, prompt, history }) => ({ id, category, prompt, history })), repeats, complete: true, summaries, results }, null, 2));
console.log(JSON.stringify({ file, summaries }));
if (summaries[1]!.passed < summaries[0]!.passed) process.exitCode = 1;
