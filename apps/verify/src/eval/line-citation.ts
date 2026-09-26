import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { AiRouter, LocalAdapter, localModels } from "@aios/ai";
import type { AppContext } from "../../../api/src/context.js";
import { registerChatRoutes } from "../../../api/src/routes/chat.js";
import { LINE_CITATION_TASKS, VALUE_ONLY_TASKS, grade, type LineCitationTask } from "./line-citation-tasks.js";
import { rate, compare, formatRate } from "./stats.js";

/**
 * 행 번호 인용 평가(docs/40). 실제 HTTP 채팅 라우트 → 구간 선택 → 프롬프트 → 라우터 → Ollama.
 * DB/Redis만 합성 대역이다. 사용자 DB·파일·환경 키를 읽지 않는다.
 *   LINE_PHASE=baseline|candidate REPEATS=5 pnpm --filter @aios/verify exec tsx src/eval/line-citation.ts
 *   LINE_COMPARE=<baseline.json>,<candidate.json> 로 두 결과를 비교만 한다.
 */
const dir = "/Volumes/T7/bigdata/eval-baselines/line-citation";
type Result = { id: string; kind: string; repeat: number; pass: boolean; valueOk: boolean; lineOk: boolean | null; lines: number[]; path?: string; text: string; status: number; totalMs: number };

if (process.env.LINE_COMPARE) {
  const [a, b] = process.env.LINE_COMPARE.split(",");
  const load = async (f: string) => JSON.parse(await readFile(f, "utf8")) as { phase: string; suiteHash: string; complete: boolean; results: Result[] };
  const [before, after] = [await load(a!), await load(b!)];
  if (before.suiteHash !== after.suiteHash) throw new Error("과제 해시가 다르다 — 비교할 수 없다");
  if (!before.complete || !after.complete) throw new Error("완료되지 않은 결과는 비교하지 않는다");
  for (const kind of ["line", "value"]) {
    const x = before.results.filter((r) => r.kind === kind), y = after.results.filter((r) => r.kind === kind);
    const rx = rate(x.filter((r) => r.pass).length, x.length), ry = rate(y.filter((r) => r.pass).length, y.length);
    console.log(`${kind}: ${before.phase} ${formatRate(rx)} → ${after.phase} ${formatRate(ry)} : ${compare(rx, ry).verdict}`);
    if (kind === "line") {
      const vx = x.filter((r) => r.valueOk).length, vy = y.filter((r) => r.valueOk).length;
      const cx = x.filter((r) => r.lines.length).length, cy = y.filter((r) => r.lines.length).length;
      console.log(`  값 정답 ${vx}/${x.length} → ${vy}/${y.length} · 행 번호를 댄 답 ${cx}/${x.length} → ${cy}/${y.length}`);
    }
  }
  process.exit(0);
}

const phase = process.env.LINE_PHASE;
if (phase !== "baseline" && phase !== "candidate") throw new Error("LINE_PHASE must be baseline or candidate");
const model = process.env.LINE_MODEL ?? "qwen3:8b";
const contextWindow = Number(process.env.LINE_CONTEXT) || 32768;
const repeats = Math.max(5, Number(process.env.REPEATS) || 5);
const base = "http://127.0.0.1:11434/v1";
const adapter = new LocalAdapter(base, "bge-m3", undefined, 4, 1, "ollama", contextWindow);
const router = new AiRouter({ local: adapter }, { catalog: localModels([model], contextWindow) });
const hash = async (paths: string[]) => { const h = createHash("sha256"); for (const p of paths) h.update(p).update(await readFile(new URL(p, import.meta.url))); return h.digest("hex"); };
const suiteHash = createHash("sha256").update(await readFile(new URL("./line-citation-tasks.ts", import.meta.url))).digest("hex");
const implementationHash = await hash(["../../../api/src/workspace.ts", "../../../api/src/agent/orchestrator.ts", "../../../api/src/routes/chat.ts", "../../../../packages/ai/src/prompt.ts"]);
await mkdir(dir, { recursive: true });
const file = `${dir}/${phase}-${new Date().toISOString().replaceAll(":", "-")}.json`;

async function run(task: LineCitationTask, repeat: number): Promise<Result> {
  const sessionId = randomUUID();
  const ctx = {
    env: { LOCAL_LLM_BASE_URL: base, LOCAL_LLM_CONTEXT: contextWindow },
    pool: { query: async (sql: string) => {
      if (sql.includes("select p.id as project_id")) return { rows: [{ project_id: null, name: null }] };
      if (sql.includes("from workspace_files")) return { rows: task.files };
      return { rows: [] };
    } },
    memory: { record: async () => {}, buildContext: async () => ({ history: [], stmSummary: null, facts: [] }) },
    retriever: { format: () => [] }, bus: { publish: async () => {} }, usage: { bind: () => {} }, router,
  } as unknown as AppContext;
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "isolated-line-eval", via: "local", role: "member", scopes: ["*"] }; });
  registerChatRoutes(app, ctx);
  const started = performance.now();
  try {
    // 웹 UI 기본값과 같은 auto 모드. 도구·장기기억 없음.
    const res = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { content: task.prompt, mode: "auto", tools: { enabled: false }, context: { useMemory: true, useLongTermMemory: false, useRag: true } } });
    const events = res.body.split("\n\n").filter((p) => p.startsWith("data: ")).map((p) => JSON.parse(p.slice(6)) as Record<string, unknown>);
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    const ok = res.statusCode === 200 && events.some((e) => e.type === "done" && e.stopReason === "end_turn") && !events.some((e) => e.type === "error");
    const g = grade(task, text);
    const path = (events.find((e) => e.type === "strategy") as { path?: string } | undefined)?.path;
    return { id: task.id, kind: task.kind, repeat, pass: ok && g.pass, valueOk: g.valueOk, lineOk: g.lineOk, lines: g.lines, path, text, status: res.statusCode, totalMs: performance.now() - started };
  } finally { await app.close(); }
}

const tasks = [...LINE_CITATION_TASKS, ...VALUE_ONLY_TASKS];
const metadata = { phase, model, contextWindow, repeats, suiteHash, implementationHash, mode: "auto", scope: "real chat route + local model; synthetic DB; holdout tasks committed before any run" };
console.log(JSON.stringify({ ...metadata, file }));
const results: Result[] = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const task of tasks) {
    const r = await run(task, repeat); results.push(r);
    await writeFile(file, JSON.stringify({ ...metadata, complete: false, results }, null, 2));
    console.log(JSON.stringify({ id: r.id, repeat, pass: r.pass, lines: r.lines, path: r.path, ms: Math.round(r.totalMs), text: r.pass ? undefined : r.text.slice(0, 140) }));
  }
}
const summarize = (kind: string) => { const x = results.filter((r) => r.kind === kind); return { passed: x.filter((r) => r.pass).length, total: x.length }; };
const summary = { line: summarize("line"), value: summarize("value") };
await writeFile(file, JSON.stringify({ ...metadata, complete: true, summary, results }, null, 2));
console.log(JSON.stringify({ file, summary }));
