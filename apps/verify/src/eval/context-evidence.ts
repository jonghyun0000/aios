import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { AiRouter, LocalAdapter, localModels } from "@aios/ai";
import type { AppContext } from "../../../api/src/context.js";
import { registerChatRoutes } from "../../../api/src/routes/chat.js";
import { CONTEXT_EVIDENCE_TASKS, type ContextEvidenceTask } from "./context-evidence-tasks.js";

// 실제 HTTP route→DB 복원 쿼리→prompt→router→Ollama. DB/Redis만 합성 대역이다.
// 환경 파일/원격 키를 읽지 않으며 실제 사용자 DB와 파일에는 접근하지 않는다.
const model = process.env.CONTEXT_MODEL ?? "qwen3:8b";
const base = "http://127.0.0.1:11434/v1";
const repeats = Math.max(3, Number(process.env.REPEATS) || 3);
const phase = process.env.CONTEXT_PHASE;
if (phase !== "baseline" && phase !== "after") throw new Error("CONTEXT_PHASE must be baseline or after");
const adapter = new LocalAdapter(base, "bge-m3", undefined, 4, 1, "ollama", 8192);
const router = new AiRouter({ local: adapter }, { catalog: localModels([model], 8192) });
const suiteHash = createHash("sha256").update(await readFile(new URL("./context-evidence-tasks.ts", import.meta.url))).digest("hex");
const implementationHasher = createHash("sha256");
for (const path of ["../../../api/src/workspace.ts", "../../../api/src/agent/preferences.ts", "../../../api/src/agent/orchestrator.ts", "../../../api/src/routes/chat.ts", "../../../../packages/ai/src/prompt.ts"]) {
  implementationHasher.update(path).update(await readFile(new URL(path, import.meta.url)));
}
const implementationHash = implementationHasher.digest("hex");
const dir = "/Volumes/T7/bigdata/eval-baselines/context-evidence";
await mkdir(dir, { recursive: true });
const file = `${dir}/${phase}-${new Date().toISOString().replaceAll(":", "-")}.json`;
type Result = { id: string; repeat: number; pass: boolean; text: string; expected: string; totalMs: number; status: number; events: unknown[] };
const results: Result[] = [];
async function run(task: ContextEvidenceTask, repeat: number): Promise<Result> {
  const sessionId = randomUUID();
  const ctx = {
    env: { LOCAL_LLM_BASE_URL: base, LOCAL_LLM_CONTEXT: 8192 },
    pool: { query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select p.id as project_id")) return { rows: [{ project_id: null, name: null }] };
      if (sql.includes("from workspace_files")) return { rows: task.files };
      if (sql.includes("from messages m join sessions")) {
        if (params[0] !== sessionId || params[1] !== "isolated-context-eval") throw new Error("fixture scope mismatch");
        const preferences = sql.includes("m.role = 'user'");
        const rows = (preferences ? task.history.filter((m) => m.role === "user").slice(-500) : task.history.slice(-100))
          .map((m, i) => ({ id: `synthetic-${i}`, role: m.role, text: preferences ? m.content.slice(0, 513) : m.content })).reverse();
        return { rows };
      }
      return { rows: [] };
    } },
    memory: { record: async () => {}, buildContext: async () => ({ history: [], stmSummary: null, facts: [] }) },
    retriever: { format: () => [] }, bus: { publish: async () => {} }, usage: { bind: () => {} }, router,
  } as unknown as AppContext;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "isolated-context-eval", via: "local", role: "member", scopes: ["*"] }; });
  registerChatRoutes(app, ctx);
  const started = performance.now();
  try {
    const res = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { content: task.prompt, mode: "fast", tools: { enabled: false }, context: { useMemory: task.useMemory, useLongTermMemory: false, useRag: false } } });
    const events = res.body.split("\n\n").filter((part) => part.startsWith("data: ")).map((part) => JSON.parse(part.slice(6)) as Record<string, unknown>);
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    const pass = res.statusCode === 200 && text.trim() === task.expected && events.some((e) => e.type === "done" && e.stopReason === "end_turn") && !events.some((e) => e.type === "error");
    return { id: task.id, repeat, pass, text, expected: task.expected, totalMs: performance.now() - started, status: res.statusCode, events: events.filter((e) => e.type !== "text_delta") };
  } finally { await app.close(); }
}
const metadata = { phase, model, protocol: "ollama", contextWindow: 8192, suiteHash, implementationHash, repeats, scope: "real API route and local model; synthetic DB/Redis; no user data; exact unchanged expected answers" };
console.log(JSON.stringify({ ...metadata, file }));
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const task of CONTEXT_EVIDENCE_TASKS) {
    const result = await run(task, repeat); results.push(result);
    await writeFile(file, JSON.stringify({ ...metadata, complete: false, results }, null, 2));
    console.log(JSON.stringify({ id: task.id, repeat, pass: result.pass, totalMs: Math.round(result.totalMs), failure: result.pass ? undefined : result.text.slice(0, 120) }));
  }
}
const summary = { passed: results.filter((r) => r.pass).length, total: results.length, cases: CONTEXT_EVIDENCE_TASKS.map((task) => ({ id: task.id, passed: results.filter((r) => r.id === task.id && r.pass).length, total: repeats })) };
await writeFile(file, JSON.stringify({ ...metadata, complete: true, summary, results }, null, 2));
console.log(JSON.stringify({ file, summary }));
if (phase === "after" && summary.passed !== summary.total) process.exitCode = 1;
