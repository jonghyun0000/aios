import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalAdapter, AnthropicAdapter, OpenAiAdapter } from "@aios/ai";
import type { ProviderAdapter } from "@aios/ai";
import type { ToolCall } from "@aios/shared";
import { TASKS, CATEGORIES, type EvalTask } from "./tasks.js";
import { rate, compare, minDetectableDelta, formatRate } from "./stats.js";

/**
 * eval 러너 — 모델/프롬프트를 바꿨을 때 품질이 어떻게 변했는지 잰다.
 *
 * **이 도구의 존재 이유는 하나의 실수다.** 프롬프트를 고치고 1회 실행이 통과하자
 * "효과 있다"고 기록했다. 두 번 더 돌리자 결론이 뒤집혔다.
 * 그래서 이 러너는 **1회 실행을 허용하지 않고**, 결과를 항상 신뢰구간과 함께 낸다.
 *
 *   pnpm --filter @aios/verify eval                    # 현재 설정 측정
 *   pnpm --filter @aios/verify eval --save baseline    # 기준선으로 저장
 *   pnpm --filter @aios/verify eval --against baseline # 기준선과 비교
 *   REPEATS=10 pnpm --filter @aios/verify eval         # 반복 횟수 조정
 */

const REPEATS = Math.max(3, Number(process.env.REPEATS) || 5);
const BASELINE_DIR = process.env.EVAL_BASELINE_DIR ?? "/Volumes/T7/bigdata/eval-baselines";

function buildAdapter(): { adapter: ProviderAdapter; model: string; label: string } {
  if (process.env.LOCAL_LLM_BASE_URL) {
    const model = (process.env.LOCAL_LLM_MODELS ?? "qwen3:8b").split(",")[0]!.trim();
    return {
      adapter: new LocalAdapter(process.env.LOCAL_LLM_BASE_URL, process.env.LOCAL_EMBED_MODEL),
      model,
      label: `local/${model}`,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { adapter: new AnthropicAdapter(process.env.ANTHROPIC_API_KEY), model: "claude-sonnet-5", label: "anthropic/claude-sonnet-5" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { adapter: new OpenAiAdapter(process.env.OPENAI_API_KEY), model: "gpt-5-mini", label: "openai/gpt-5-mini" };
  }
  throw new Error("프로바이더가 없다 — LOCAL_LLM_BASE_URL 또는 API 키를 설정하라");
}

/** 사고 모델은 예산을 사고와 응답이 나눠 쓴다 — 이걸 빼먹으면 멀쩡한 모델을 굶긴다. */
const THINKING_HEADROOM = 2_000;
const fast = process.env.EVAL_REASONING === "off";

async function runOnce(
  adapter: ProviderAdapter,
  model: string,
  task: EvalTask,
): Promise<{ pass: boolean; detail: string }> {
  const calls: ToolCall[] = [];
  let out = "";
  try {
    for await (const ev of adapter.stream({
      model,
      messages: [{ role: "user", content: task.prompt }],
      maxTokens: (task.maxTokens ?? 300) + (fast ? 0 : THINKING_HEADROOM),
      ...(fast ? { reasoning: "off" as const } : {}),
      ...(task.kind === "tool" ? { tools: task.tools } : {}),
    })) {
      if (ev.type === "text_delta") out += ev.text;
      if (ev.type === "tool_call") calls.push(ev.call);
    }
  } catch (e) {
    return { pass: false, detail: `오류: ${e instanceof Error ? e.message : String(e)}` };
  }
  const pass = task.kind === "tool" ? task.check(calls, out) : task.check(out);
  const shown = task.kind === "tool" && calls.length
    ? calls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 60)})`).join(" ")
    : out.replace(/\s+/g, " ").trim().slice(0, 90);
  return { pass, detail: shown || "(빈 응답)" };
}

export interface EvalReport {
  label: string;
  repeats: number;
  at: string;
  tasks: Record<string, { successes: number; n: number; lastFailure?: string }>;
  categories: Record<string, { successes: number; n: number }>;
  overall: { successes: number; n: number };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveAs = args.includes("--save") ? args[args.indexOf("--save") + 1] : undefined;
  const against = args.includes("--against") ? args[args.indexOf("--against") + 1] : undefined;

  const { adapter, model, label } = buildAdapter();
  console.log(`\n${"=".repeat(72)}`);
  console.log(`EVAL — ${label}, 과제 ${TASKS.length}개 × 반복 ${REPEATS}회 = ${TASKS.length * REPEATS}회 호출`);
  console.log(`이 표본으로 탐지 가능한 최소 개선: ${(minDetectableDelta(TASKS.length * REPEATS) * 100).toFixed(1)}%p`);
  console.log(`${"=".repeat(72)}\n`);

  const report: EvalReport = {
    label: `${label}${fast ? " (reasoning off)" : ""}`, repeats: REPEATS, at: new Date().toISOString(),
    tasks: {}, categories: {}, overall: { successes: 0, n: 0 },
  };
  for (const c of CATEGORIES) report.categories[c] = { successes: 0, n: 0 };

  for (const task of TASKS) {
    const t = report.tasks[task.id] = { successes: 0, n: 0, lastFailure: undefined as string | undefined };
    for (let i = 0; i < REPEATS; i++) {
      const r = await runOnce(adapter, model, task);
      t.n++;
      if (r.pass) t.successes++;
      else t.lastFailure = r.detail;
    }
    const cat = report.categories[task.category]!;
    cat.successes += t.successes; cat.n += t.n;
    report.overall.successes += t.successes; report.overall.n += t.n;

    const r = rate(t.successes, t.n);
    const mark = r.rate === 1 ? "✓" : r.rate === 0 ? "✗" : "~";
    console.log(`  ${mark} ${task.id.padEnd(34)} ${formatRate(r)}`);
    if (t.lastFailure) console.log(`      실패 예: ${t.lastFailure}`);
  }

  console.log(`\n  ${"-".repeat(68)}`);
  for (const c of CATEGORIES) {
    const cc = report.categories[c]!;
    console.log(`  ${c.padEnd(12)} ${formatRate(rate(cc.successes, cc.n))}`);
  }
  console.log(`  ${"전체".padEnd(11)} ${formatRate(rate(report.overall.successes, report.overall.n))}`);

  if (saveAs) {
    await mkdir(BASELINE_DIR, { recursive: true });
    const p = join(BASELINE_DIR, `${saveAs}.json`);
    await writeFile(p, JSON.stringify(report, null, 2));
    console.log(`\n  기준선 저장: ${p}`);
  }

  if (against) {
    const p = join(BASELINE_DIR, `${against}.json`);
    const base = JSON.parse(await readFile(p, "utf8")) as EvalReport;
    console.log(`\n  ${"=".repeat(68)}`);
    console.log(`  기준선 대비 (${base.label}, ${base.at.slice(0, 10)})`);
    console.log(`  ${"-".repeat(68)}`);
    for (const c of CATEGORIES) {
      const b = base.categories[c], a = report.categories[c];
      if (!b || !a) continue;
      const cmp = compare(rate(b.successes, b.n), rate(a.successes, a.n));
      console.log(`  ${c.padEnd(12)} ${(cmp.delta * 100 >= 0 ? "+" : "")}${(cmp.delta * 100).toFixed(0)}%p  ${cmp.verdict}`);
    }
    const o = compare(rate(base.overall.successes, base.overall.n), rate(report.overall.successes, report.overall.n));
    console.log(`  ${"전체".padEnd(11)} ${(o.delta * 100 >= 0 ? "+" : "")}${(o.delta * 100).toFixed(0)}%p  ${o.verdict}`);
    if (o.verdict === "구분 불가") {
      // "차이 없음"이 아니다. 그 구분을 사람의 해석에 맡기지 않는다.
      console.log(`\n  ※ "구분 불가"는 차이가 없다는 뜻이 아니라 이 표본으로는 알 수 없다는 뜻이다.`);
      console.log(`     확증하려면 REPEATS 를 늘려라 (현재 ${REPEATS}).`);
    }
    console.log(`  ${"=".repeat(68)}`);
  }
  console.log();
}

await main();
