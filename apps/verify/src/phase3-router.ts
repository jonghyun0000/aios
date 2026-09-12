/**
 * Phase 3 — AI Router 검증 + 프로바이더 비교.
 *
 * 실측 항목(프로바이더별): Latency(TTFT/total) / Cost / Quality / Tool Calling / Streaming / JSON Mode.
 * 키가 없는 프로바이더는 SKIP으로 표시하고, 라우팅 정책 검증은 항상 수행한다
 * (정책은 카탈로그 기반 결정론적 로직이라 키 없이도 검증 가능).
 */
import { AiRouter, AnthropicAdapter, GeminiAdapter, LocalAdapter, MODEL_CATALOG, OpenAiAdapter, XaiAdapter, costUsd, findModel, localModels } from "@aios/ai";
import type { ProviderAdapter } from "@aios/ai";
import type { ProviderId, ToolSpec } from "@aios/shared";
import { Report } from "./report.js";

const r = new Report("PHASE 3 — AI Router & Provider Comparison");

const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
if (process.env.ANTHROPIC_API_KEY) adapters.anthropic = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY);
if (process.env.OPENAI_API_KEY) adapters.openai = new OpenAiAdapter(process.env.OPENAI_API_KEY);
if (process.env.GEMINI_API_KEY) adapters.gemini = new GeminiAdapter(process.env.GEMINI_API_KEY);
if (process.env.XAI_API_KEY) adapters.xai = new XaiAdapter(process.env.XAI_API_KEY);
// 로컬 추론 서버도 프로바이더다. 빼 두면 외부 키 없는 구성에서 라우터 검증이 통째로 죽는다.
if (process.env.LOCAL_LLM_BASE_URL) {
  adapters.local = new LocalAdapter(process.env.LOCAL_LLM_BASE_URL, process.env.LOCAL_EMBED_MODEL, undefined, Number(process.env.LOCAL_EMBED_CONCURRENCY) || undefined, Number(process.env.LOCAL_CHAT_CONCURRENCY) || undefined);
}
const LOCAL_CATALOG = process.env.LOCAL_LLM_BASE_URL
  ? localModels((process.env.LOCAL_LLM_MODELS ?? "qwen3:8b").split(","), Number(process.env.LOCAL_LLM_CONTEXT) || 32768)
  : [];
const FULL_CATALOG = [...MODEL_CATALOG, ...LOCAL_CATALOG];

const live = Object.keys(adapters) as ProviderId[];
console.log(`  configured providers: ${live.join(", ") || "(none)"}`);

const weatherTool: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false,
  },
};

interface Bench {
  provider: ProviderId;
  model: string;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  deltas: number;
  toolOk: boolean;
  jsonOk: boolean;
  qualityScore: number;
  error?: string;
}

/** 각 프로바이더의 대표 모델 하나씩 (품질 tier 3 우선) */
function flagshipFor(p: ProviderId): string | undefined {
  const candidates = MODEL_CATALOG.filter((m) => m.provider === p).sort((a, b) => b.qualityTier - a.qualityTier);
  return candidates[0]?.id;
}

/**
 * 품질 채점 — LLM-as-judge 없이 결정론적으로 채점한다.
 * 이유: judge를 쓰면 채점 자체가 비결정론이 되어 회귀 감지가 불가능해진다.
 * 사실성·지시 준수·형식 준수를 코드로 검증 가능한 과제만 사용.
 */
const QUALITY_TASKS: { prompt: string; check: (out: string) => boolean; label: string }[] = [
  {
    label: "arithmetic",
    prompt: "What is 17 * 23 + 41? Reply with only the number.",
    check: (o) => /\b432\b/.test(o),
  },
  {
    label: "instruction-following",
    prompt: "List exactly three programming languages, one per line, no numbering, no extra text.",
    check: (o) => {
      const lines = o.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.length === 3 && lines.every((l) => !/^\d/.test(l) && l.length < 30);
    },
  },
  {
    label: "code-correctness",
    prompt:
      "Write a TypeScript function `sumEven(xs: number[]): number` that returns the sum of even numbers. Reply with only the code, no fences, no explanation.",
    check: (o) => /function\s+sumEven/.test(o) && /%\s*2/.test(o) && /reduce|for|\+=/.test(o),
  },
  {
    label: "negation-handling",
    prompt: "Name a European country that does NOT use the euro. Reply with only the country name.",
    check: (o) => /norway|sweden|denmark|poland|switzerland|united kingdom|uk|czech|hungary|romania|bulgaria|iceland/i.test(o),
  },
];

async function benchmark(provider: ProviderId, adapter: ProviderAdapter, model: string): Promise<Bench> {
  const info = findModel(model)!;
  const b: Bench = {
    provider, model, ttftMs: 0, totalMs: 0, inputTokens: 0, outputTokens: 0,
    costUsd: 0, deltas: 0, toolOk: false, jsonOk: false, qualityScore: 0,
  };

  // --- Latency + Streaming + Usage ---
  // maxTokens는 사고+응답을 함께 제한하므로 사고형 모델에 충분한 여유를 준다.
  const t0 = Date.now();
  let thinkingChars = 0;
  for await (const ev of adapter.stream({
    model,
    messages: [{ role: "user", content: "Write 120 words about the CAP theorem. Plain prose." }],
    maxTokens: 4096,
  })) {
    if (ev.type === "thinking_delta") thinkingChars += ev.text.length;
    if (ev.type === "text_delta") {
      if (b.deltas === 0) b.ttftMs = Date.now() - t0;
      b.deltas++;
    }
    if (ev.type === "usage") {
      b.inputTokens = ev.usage.inputTokens;
      b.outputTokens = ev.usage.outputTokens;
    }
  }
  b.totalMs = Date.now() - t0;
  b.costUsd = costUsd(info, b.inputTokens, b.outputTokens);
  if (thinkingChars > 0) console.log(`    (${provider} emitted ${thinkingChars} chars of summarized thinking)`);

  // --- Tool calling ---
  try {
    const calls: string[] = [];
    for await (const ev of adapter.stream({
      model,
      messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
      tools: [weatherTool],
      maxTokens: 300,
    })) {
      if (ev.type === "tool_call") calls.push(String((ev.call.arguments as { city?: string }).city ?? ""));
    }
    b.toolOk = calls.length === 1 && /seoul/i.test(calls[0] ?? "");
  } catch (e) {
    b.error = `tool: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
  }

  // --- JSON mode (프롬프트 기반 — 4사 공통으로 지원되는 유일한 방식) ---
  try {
    let out = "";
    for await (const ev of adapter.stream({
      model,
      system: 'Respond with a single JSON object only. No prose, no code fences.',
      messages: [{ role: "user", content: 'Return {"city":"Seoul","country":"South Korea","population_millions":<number>}' }],
      maxTokens: 200,
    })) {
      if (ev.type === "text_delta") out += ev.text;
    }
    const cleaned = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as { city?: string; population_millions?: number };
    b.jsonOk = parsed.city === "Seoul" && typeof parsed.population_millions === "number";
  } catch {
    b.jsonOk = false;
  }

  // --- Quality ---
  let passed = 0;
  for (const task of QUALITY_TASKS) {
    let out = "";
    try {
      for await (const ev of adapter.stream({ model, messages: [{ role: "user", content: task.prompt }], maxTokens: 300 })) {
        if (ev.type === "text_delta") out += ev.text;
      }
      if (task.check(out)) passed++;
    } catch { /* counts as failure */ }
  }
  b.qualityScore = passed / QUALITY_TASKS.length;
  return b;
}

// ---------- 3.1 프로바이더별 실측 ----------
r.section("3.1 Provider benchmarks (실제 호출)");
const benches: Bench[] = [];
for (const p of ["anthropic", "openai", "gemini"] as ProviderId[]) {
  const adapter = adapters[p];
  const model = flagshipFor(p);
  if (!adapter || !model) {
    console.log(`  SKIP  ${p} — no API key configured`);
    continue;
  }
  await r.guard(`bench.${p}`, async () => {
    const b = await benchmark(p, adapter, model);
    benches.push(b);
    r.check(`bench.${p}.streaming`, b.deltas > 3, `${b.deltas} deltas`);
    r.check(`bench.${p}.usage_reported`, b.inputTokens > 0 && b.outputTokens > 0, `in=${b.inputTokens} out=${b.outputTokens}`);
    r.check(`bench.${p}.tool_calling`, b.toolOk, b.toolOk ? "ok" : (b.error ?? "tool call not produced/parsed"));
    r.check(`bench.${p}.json_mode`, b.jsonOk, b.jsonOk ? "parsed" : "failed to produce parseable JSON");
    r.check(`bench.${p}.quality`, b.qualityScore >= 0.75, `${(b.qualityScore * 100).toFixed(0)}% of ${QUALITY_TASKS.length} deterministic tasks`);
  });
}

// ---------- 비교표 ----------
if (benches.length > 0) {
  console.log("\n  ┌─ Provider comparison " + "─".repeat(46));
  console.log("  │ provider   model                 TTFT   total   in/out    cost      tool json qual");
  for (const b of benches) {
    console.log(
      `  │ ${b.provider.padEnd(10)} ${b.model.padEnd(20)} ${String(b.ttftMs).padStart(5)}ms ${String(b.totalMs).padStart(5)}ms ` +
        `${String(b.inputTokens + "/" + b.outputTokens).padStart(9)} $${b.costUsd.toFixed(5)} ` +
        `${b.toolOk ? " ok " : "FAIL"} ${b.jsonOk ? " ok " : "FAIL"} ${(b.qualityScore * 100).toFixed(0)}%`,
    );
  }
  console.log("  └" + "─".repeat(68));
}

// ---------- 3.2 라우팅 정책 (결정론적) ----------
r.section("3.2 Routing policy");
{
  /*
   * 랭킹 정책은 순수 계산이다 — 어떤 프로바이더도 호출하지 않는다.
   * 그런데 실제 어댑터 유무로 후보 카탈로그가 걸러지는 바람에,
   * 키가 없는 구성에서는 정책 자체가 **검증되지 않은 채** 넘어갔다.
   * 정책을 재려면 카탈로그가 온전해야 하므로 스트림하지 않는 스텁을 모든 프로바이더에 꽂는다.
   * (rank() 는 adapters[provider] 의 존재만 본다.)
   */
  const stub = {
    id: "anthropic" as ProviderId,
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> { throw new Error("정책 검증은 스트림하지 않는다"); },
  };
  const policyAdapters: Partial<Record<ProviderId, ProviderAdapter>> = {
    anthropic: { ...stub, id: "anthropic" }, openai: { ...stub, id: "openai" },
    gemini: { ...stub, id: "gemini" }, xai: { ...stub, id: "xai" },
    ...(LOCAL_CATALOG.length ? { local: { ...stub, id: "local" as ProviderId } } : {}),
  };
  const router = new AiRouter(policyAdapters, { catalog: FULL_CATALOG });

  const codeTop = router.rank({ taskClass: "code" })[0]!;
  r.check("policy.code_prefers_frontier", codeTop.qualityTier === 3,
    `code → ${codeTop.id} (tier ${codeTop.qualityTier})`);

  const cheapTop = router.rank({ taskClass: "cheap" })[0]!;
  const codeCost = costUsd(codeTop, 4000, 2000);
  const cheapCost = costUsd(cheapTop, 4000, 2000);
  r.check("policy.cheap_prefers_cheap", cheapCost <= codeCost,
    `cheap → ${cheapTop.id} ($${cheapCost.toFixed(5)}) vs code → ${codeTop.id} ($${codeCost.toFixed(5)})`);

  const summTop = router.rank({ taskClass: "summarize" })[0]!;
  r.check("policy.summarize_not_frontier", costUsd(summTop, 4000, 2000) <= codeCost,
    `summarize → ${summTop.id}`);

  // 컨텍스트 필터: 거대한 입력은 작은 윈도우 모델을 후보에서 제거해야 한다
  const big = router.rank({ taskClass: "chat", estimatedInputTokens: 300_000 });
  r.check("policy.context_filter", big.every((m) => m.contextWindow >= 300_000 / 0.9),
    `${big.length} candidates survive a 300k-token prompt: ${big.map((m) => m.id).join(", ") || "(none)"}`);

  // 비용 상한
  const capped = router.rank({ taskClass: "code", maxCostUsd: 0.005, estimatedInputTokens: 4000 });
  r.check("policy.cost_cap", capped.every((m) => costUsd(m, 4000, 2000) <= 0.005),
    `${capped.length} candidates under $0.005: ${capped.map((m) => m.id).join(", ") || "(none)"}`);

  // 도구 필터
  const needTools = router.rank({ taskClass: "chat", needTools: true });
  r.check("policy.tool_filter", needTools.every((m) => m.supportsTools), `${needTools.length} tool-capable candidates`);

  // 사용자 모델 고정은 존중되고 폴백하지 않아야 한다
  const pinned = router.rank({ model: codeTop.id });
  r.check("policy.pinned_model_no_fallback", pinned.length === 1 && pinned[0]!.id === codeTop.id,
    `pinned ${codeTop.id} → ${pinned.length} candidate(s)`);

  // 알 수 없는 모델은 조용히 대체되지 않고 에러여야 한다
  let threw = false;
  try { router.rank({ model: "not-a-real-model" }); } catch { threw = true; }
  r.check("policy.unknown_model_errors", threw, "unknown model id rejected instead of silently substituted");
}

// ---------- 3.3 폴백 & 서킷브레이커 (실제 프로바이더 + 고장난 프로바이더 혼합) ----------
r.section("3.3 Fallback & circuit breaker");
await r.guard("fallback", async () => {
  /*
   * 폴백은 '고장난 1순위 → 살아 있는 2순위'를 실제로 통과시켜야 의미가 있다.
   * Claude 를 못 박아 두면 로컬 모델만 있는 구성에서 검증이 실패로 기록된다 —
   * 폴백이 깨진 것과 구분되지 않는다. 살아 있는 프로바이더 아무거나 2순위로 쓴다.
   */
  const goodId: ProviderId | undefined = adapters.anthropic ? "anthropic" : adapters.local ? "local" : live[0];
  const good = goodId ? adapters[goodId] : undefined;
  if (!goodId || !good) { r.check("fallback.skipped", false, "살아 있는 프로바이더가 하나도 없다"); return; }
  const goodModel = goodId === "local" ? LOCAL_CATALOG[0]! : { ...findModel(flagshipFor(goodId)!)!, id: flagshipFor(goodId)! };
  // 항상 529를 던지는 가짜 프로바이더를 1순위로 두고, 살아 있는 프로바이더를 2순위로 둔다
  const broken: ProviderAdapter = {
    id: "openai",
    // eslint-disable-next-line require-yield
    async *stream() { throw new (await import("@aios/shared")).ProviderError("openai", "overloaded", { status: 529 }); },
  };
  /*
   * 고장난 프로바이더가 **반드시 1순위**여야 폴백을 시험하는 것이 된다.
   * 이전에는 Claude(유료)를 2순위로 두어 자연히 그렇게 됐는데, 2순위가 무료 로컬 모델이 되자
   * cheap 가중에서 로컬이 1위로 올라가 고장난 쪽을 아예 거치지 않았다 —
   * 그래도 "폴백 성공"으로 보였다. 순위를 우연에 맡기지 않고 카탈로그로 고정한다.
   */
  const catalog = [
    {
      ...MODEL_CATALOG.find((m) => m.provider === "openai")!,
      provider: "openai" as const,
      inputCostPerMTok: 0, outputCostPerMTok: 0, qualityTier: 3 as const, // 어느 축으로도 1위
    },
    { ...goodModel, qualityTier: 1 as const },
  ];
  const router = new AiRouter({ [goodId]: good, openai: broken }, { catalog });

  const routed: string[] = [];
  let text = "";
  for await (const ev of router.stream({ messages: [{ role: "user", content: "Reply with exactly: FALLBACK-OK" }], maxTokens: 32 }, { taskClass: "cheap" })) {
    if (ev.type === "routed") routed.push(ev.provider);
    if (ev.type === "text_delta") text += ev.text;
  }
  r.check("fallback.recovers", text.includes("FALLBACK-OK"), `routed chain: ${routed.join(" → ")}`);
  r.check("fallback.tried_broken_first", routed[0] === "openai" && routed.includes(goodId),
    `first=${routed[0]}, recovered on=${routed[routed.length - 1]}`);

  /*
   * 브레이커는 우리 로직이므로 **모델 속도가 판정을 좌우하면 안 된다.**
   * 위 라우터(회복 담당이 실제 프로바이더)로 6회를 돌리면, 로컬 7B 기준 회당 수십 초라
   * 마지막 스냅샷을 볼 때쯤 브레이커의 60초 open 창이 이미 지나 half-open 으로 스스로
   * 리셋된다 — 브레이커가 정상 동작했는데 `open=false` 로 읽혀 실패로 기록됐다.
   * 그래서 회복 담당만 즉답 스텁으로 바꿔 실패 누적 구간을 밀리초 단위로 만든다.
   * (실제 프로바이더를 통한 폴백은 바로 위 두 단언이 이미 증명했다.)
   */
  const instant: ProviderAdapter = {
    id: "anthropic",
    async *stream() {
      yield { type: "text_delta", text: "OK" } as never;
      yield { type: "done", stopReason: "end_turn" } as never;
    },
  };
  const breakerCatalog = [
    catalog[0]!,
    { ...MODEL_CATALOG.find((m) => m.provider === "anthropic")!, qualityTier: 1 as const },
  ];
  const breakerRouter = new AiRouter({ openai: broken, anthropic: instant }, { catalog: breakerCatalog });
  for (let i = 0; i < 6; i++) {
    for await (const _ of breakerRouter.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 8 }, { taskClass: "cheap" })) { /* drain */ }
  }
  const snapshot = breakerRouter.snapshot().find((s) => s.provider === "openai");
  r.check("breaker.opens_after_failures", snapshot?.open === true,
    `openai breaker open=${snapshot?.open}, successRate=${snapshot?.successRate.toFixed(2)} — 5회 연속 실패로 후보에서 제외`);
});

r.finish();
