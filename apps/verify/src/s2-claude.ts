/**
 * Sprint 2 · Step 2 — Claude 실사용 검증.
 *
 * Streaming / Tool Calling / Long Conversation / Context Window /
 * Token Usage / Retry / Timeout / Rate Limit / Error Handling.
 *
 * 모든 요청·응답을 logs/s2-claude.jsonl 에 와이어 레벨로 남긴다(키는 마스킹).
 * Sprint 1과 달리 '긴 대화'와 'rate limit'을 실제로 밟는다.
 */
import { AnthropicAdapter, AiRouter, costUsd, findModel } from "@aios/ai";
import { ProviderError, estimateTokens } from "@aios/shared";
import type { ChatMessage, StreamEvent, ToolCall, ToolSpec } from "@aios/shared";
import { join } from "node:path";
import { Report } from "./report.js";
import { WireLogger } from "./wire-log.js";

const KEY = process.env.ANTHROPIC_API_KEY;
const r = new Report("SPRINT 2 · STEP 2 — Claude live verification");

if (!KEY) {
  r.check("provider.key_present", false, "ANTHROPIC_API_KEY is not set — cannot verify live behaviour");
  r.finish();
}

const LOG = join(process.cwd(), "logs", "s2-claude.jsonl");
const wire = new WireLogger(LOG, "s2-claude");
await wire.install();
console.log(`  wire log: ${LOG}`);

const adapter = new AnthropicAdapter(KEY!);
const MODEL = "claude-sonnet-5";
const CHEAP = "claude-haiku-4-5";

/**
 * 시작 전에 프로바이더가 실제로 응답하는지 확인한다.
 * 크레딧 소진·결제 미설정 상태에서 34개 검사를 전부 돌리면 34개의 무의미한 FAIL이 쌓이고,
 * 보고서를 읽는 사람은 "제품이 망가졌다"고 오해한다. 한 번 찔러 보고 차단이면 즉시 멈춘다.
 */
{
  try {
    for await (const _ of adapter.stream({
      model: CHEAP, messages: [{ role: "user", content: "hi" }], maxTokens: 8, reasoning: "off",
    })) { /* drain */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/credit balance|insufficient[_ ]quota|billing|payment required|quota exceeded/i.test(msg)) {
      wire.uninstall();
      await r.guard("provider.reachable", () => Promise.reject(new Error(msg)));
      r.finish();
    }
    // 그 외의 실패는 실제 검사에서 다뤄야 하므로 여기서 삼키지 않는다
  }
}

const weatherTool: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};

/** 스트림을 소비하며 관심 있는 값만 뽑아낸다 */
async function collect(gen: AsyncGenerator<StreamEvent>) {
  const out = {
    text: "", thinking: "", deltas: 0, thinkingDeltas: 0, ttftMs: 0,
    calls: [] as ToolCall[], usage: null as { inputTokens: number; outputTokens: number } | null,
    stop: "" as string, totalMs: 0,
  };
  const t0 = Date.now();
  for await (const ev of gen) {
    switch (ev.type) {
      case "text_delta":
        if (out.deltas === 0) out.ttftMs = Date.now() - t0;
        out.deltas++;
        out.text += ev.text;
        break;
      case "thinking_delta": out.thinkingDeltas++; out.thinking += ev.text; break;
      case "tool_call": out.calls.push(ev.call); break;
      case "usage": out.usage = ev.usage; break;
      case "done": out.stop = ev.stopReason; break;
    }
  }
  out.totalMs = Date.now() - t0;
  return out;
}

try {
  // ---------- 2.1 Streaming ----------
  r.section("2.1 Streaming");
  await r.guard("streaming", async () => {
    const res = await collect(adapter.stream({
      model: MODEL,
      messages: [{ role: "user", content: "Write exactly 150 words about write-ahead logging. Plain prose, no headings." }],
      maxTokens: 4096,
    }));
    r.check("stream.incremental_deltas", res.deltas > 5, `${res.deltas} text deltas, ${res.text.length} chars`);
    r.check("stream.ttft_reasonable", res.ttftMs > 0 && res.ttftMs < 60_000, `TTFT=${res.ttftMs}ms total=${res.totalMs}ms`);
    r.check("stream.terminates_cleanly", res.stop === "end_turn", `stopReason=${res.stop}`);

    // 사고 채널은 '사고가 필요한 과제'로 검증해야 한다. adaptive thinking은 단순 작문에서
    // 사고를 생략하므로, 아무 프롬프트에나 thinking 델타를 요구하면 정상 동작을 실패로 오판한다.
    const hard = await collect(adapter.stream({
      model: MODEL,
      messages: [{
        role: "user",
        content:
          "Three switches outside a windowless room control three bulbs inside. You may flip switches freely " +
          "but may enter the room only once. Determine which switch controls which bulb, and state the procedure.",
      }],
      maxTokens: 8192,
      reasoning: "auto",
    }));
    // 관측만 한다 — 게이트로 쓰지 않는다. adaptive thinking은 사고 여부를 모델이 매번
    // 결정하므로(같은 프롬프트에 1회차 사고 없음/2회차 사고 있음을 실측) 비결정론적이다.
    // 파싱 경로 자체는 packages/ai/src/__tests__/thinking.test.ts 가 녹화 프레임으로 결정론 검증한다.
    console.log(`    observed: ${hard.thinkingDeltas} thinking deltas (${hard.thinking.length} chars) on a reasoning task ` +
      `— adaptive thinking decides per request, so this is reported, not asserted`);
    r.check("stream.thinking_not_mixed_into_answer",
      hard.thinking.length === 0 || !hard.text.includes(hard.thinking.slice(0, 60)),
      "invariant holds: when reasoning is emitted it never appears inside the answer text");
  });

  // ---------- 2.2 Tool Calling ----------
  r.section("2.2 Tool calling");
  await r.guard("tools", async () => {
    const one = await collect(adapter.stream({
      model: MODEL,
      messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
      tools: [weatherTool], maxTokens: 4096,
    }));
    r.check("tool.single_call", one.calls.length === 1 && one.calls[0]!.name === "get_weather",
      `stop=${one.stop} args=${JSON.stringify(one.calls[0]?.arguments)}`);
    r.check("tool.id_format_valid", one.calls.every((c) => /^[a-zA-Z0-9_-]+$/.test(c.id)),
      `ids: ${one.calls.map((c) => c.id).join(", ")}`);

    const par = await collect(adapter.stream({
      model: MODEL,
      messages: [{ role: "user", content: "Get the weather for Seoul AND Tokyo AND Osaka. Call the tool for each." }],
      tools: [weatherTool], maxTokens: 4096,
    }));
    r.check("tool.parallel_calls", par.calls.length >= 2,
      `${par.calls.length} calls: ${par.calls.map((c) => JSON.stringify(c.arguments)).join(", ")}`);

    const round = await collect(adapter.stream({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Seoul? Use the tool." },
        { role: "assistant", content: "", toolCalls: one.calls },
        { role: "tool", content: "18°C, clear sky", toolCallId: one.calls[0]!.id },
      ],
      tools: [weatherTool], maxTokens: 4096,
    }));
    r.check("tool.result_roundtrip", /18/.test(round.text), `"${round.text.trim().slice(0, 90)}"`);
  });

  // ---------- 2.3 Long conversation (다중 턴 + 도구 결과 누적) ----------
  r.section("2.3 Long conversation");
  await r.guard("long_convo", async () => {
    const convo: ChatMessage[] = [];
    const secrets = ["ALPHA-7391", "BRAVO-2264", "CHARLIE-8815", "DELTA-5507"];
    // 20턴 대화를 만들며 중간중간 기억해야 할 토큰을 심는다
    for (let i = 0; i < secrets.length; i++) {
      convo.push({ role: "user", content: `Remember code ${i + 1}: ${secrets[i]}. Just acknowledge with OK.` });
      const res = await collect(adapter.stream({ model: CHEAP, messages: convo, maxTokens: 2048, reasoning: "off" }));
      convo.push({ role: "assistant", content: res.text });
      // 사이사이 잡담을 채워 대화를 길게 만든다
      for (let j = 0; j < 3; j++) {
        convo.push({ role: "user", content: `Filler turn ${i}-${j}: say the word "noted" and nothing else.` });
        const f = await collect(adapter.stream({ model: CHEAP, messages: convo, maxTokens: 512, reasoning: "off" }));
        convo.push({ role: "assistant", content: f.text });
      }
    }
    const turns = convo.length;
    const approxTokens = convo.reduce((s, m) => s + estimateTokens(m.content), 0);

    // 대화 초반의 정보를 회상할 수 있는가
    convo.push({ role: "user", content: "What was code 1? Reply with only the code." });
    const recall = await collect(adapter.stream({ model: CHEAP, messages: convo, maxTokens: 512, reasoning: "off" }));
    r.check("long.multi_turn_stable", turns >= 32, `${turns} messages exchanged without a protocol error`);
    r.check("long.recalls_early_context", recall.text.includes("ALPHA-7391"),
      `asked for code 1 after ${turns} messages (~${approxTokens} tokens) → "${recall.text.trim().slice(0, 40)}"`);
    r.check("long.usage_scales", (recall.usage?.inputTokens ?? 0) > approxTokens * 0.5,
      `input tokens grew with the conversation: ${recall.usage?.inputTokens} reported vs ~${approxTokens} estimated`);
  });

  // ---------- 2.4 Context window ----------
  r.section("2.4 Context window");
  await r.guard("context", async () => {
    const info = findModel(MODEL)!;
    const filler = "The quick brown fox jumps over the lazy dog. ".repeat(9000); // ~400KB
    const est = estimateTokens(filler);
    const res = await collect(adapter.stream({
      model: MODEL,
      messages: [{ role: "user", content: `${filler}\n\nIgnore everything above. Reply with exactly: BIGCTX-OK` }],
      maxTokens: 4096,
    }));
    const actual = res.usage?.inputTokens ?? 0;
    r.check("context.large_input_accepted", res.text.includes("BIGCTX-OK"),
      `${(filler.length / 1024).toFixed(0)}KB input → ${actual} tokens, answered correctly`);
    r.check("context.estimator_conservative", est >= actual * 0.9,
      `estimate ${est} vs actual ${actual} (estimator must not undercount: ratio ${(est / actual).toFixed(2)})`);
    r.check("context.within_catalog_window", actual < info.contextWindow,
      `${actual} < catalog ${info.contextWindow}`);

    // 컨텍스트 초과를 실제로 유발했을 때 명확한 에러가 나는가
    const tooBig = "x ".repeat(700_000); // ~1.4MB → 200k+ 토큰이지만 1M 윈도우 아래
    let overflowErr: unknown = null;
    try {
      await collect(adapter.stream({
        model: CHEAP, // haiku는 200k 윈도우 → 확실히 초과
        messages: [{ role: "user", content: tooBig }], maxTokens: 128, reasoning: "off",
      }));
    } catch (e) { overflowErr = e; }
    r.check("context.overflow_is_clear_error",
      overflowErr instanceof ProviderError && !overflowErr.retryable,
      overflowErr instanceof Error ? `${overflowErr.message.slice(0, 110)}` : "no error raised (unexpected)");
  });

  // ---------- 2.5 Token usage & cost ----------
  r.section("2.5 Token usage & cost");
  await r.guard("usage", async () => {
    const info = findModel(CHEAP)!;
    const res = await collect(adapter.stream({
      model: CHEAP, messages: [{ role: "user", content: "Say hello in one short sentence." }],
      maxTokens: 256, reasoning: "off",
    }));
    const cost = costUsd(info, res.usage!.inputTokens, res.usage!.outputTokens);
    r.check("usage.reported", (res.usage?.inputTokens ?? 0) > 0 && (res.usage?.outputTokens ?? 0) > 0,
      `in=${res.usage?.inputTokens} out=${res.usage?.outputTokens}`);
    r.check("usage.cost_matches_catalog", cost > 0 && cost < 0.001,
      `$${cost.toFixed(7)} at $${info.inputCostPerMTok}/$${info.outputCostPerMTok} per MTok`);

    // 사고 ON/OFF의 출력 토큰 차이가 실제로 관찰되는가 (비용 정책의 근거)
    const withThinking = await collect(adapter.stream({
      model: MODEL, messages: [{ role: "user", content: "What is 234 * 567? Show the result." }],
      maxTokens: 4096, reasoning: "auto",
    }));
    const without = await collect(adapter.stream({
      model: MODEL, messages: [{ role: "user", content: "What is 234 * 567? Show the result." }],
      maxTokens: 4096, reasoning: "off",
    }));
    // 관측만 한다. adaptive thinking은 요청마다 모델이 사고 여부를 정하므로, 같은 프롬프트에도
    // 어떤 실행에서는 사고를 생략한다(실측: 448 vs 163 = 2.7배인 실행도, 163 vs 170 = 1.0배인
    // 실행도 있었다). 모델의 재량을 게이트로 쓰면 CI가 무작위로 빨개진다.
    const withTok = withThinking.usage?.outputTokens ?? 0;
    const offTok = without.usage?.outputTokens ?? 0;
    console.log(`    observed: reasoning=auto → ${withTok} output tokens, reasoning=off → ${offTok} ` +
      `(${(withTok / Math.max(offTok, 1)).toFixed(1)}x) — the model decides per request, so this is reported, not asserted`);

    // 게이트로 삼을 수 있는 것은 '우리가 통제하는 것'뿐이다:
    // reasoning="off"는 요청 파라미터이므로 결정론적으로 사고를 끈다.
    r.check("usage.reasoning_off_suppresses_thinking", without.thinkingDeltas === 0,
      `reasoning="off" produced ${without.thinkingDeltas} thinking deltas (must be 0 — this is a request parameter, not a model choice)`);
    // 답변 '내용'에 대한 단정은 넣지 않는다. 같은 질문에도 사고 여부·서식·자릿수 표기가
    // 실행마다 달라지므로(실측: auto 실행에서 정규식 불일치) 이런 검사는 무작위로 실패한다.
    // 내용 정확성은 phase3의 결정론적 품질 과제(4개 중 3개 통과 임계)가 담당한다.
    console.log(`    answers: auto="${withThinking.text.trim().slice(0, 50)}" | off="${without.text.trim().slice(0, 50)}"`);
  });

  // ---------- 2.6 Error handling ----------
  r.section("2.6 Error handling");
  await r.guard("errors", async () => {
    const cases: { name: string; run: () => Promise<unknown>; expectRetryable: boolean }[] = [
      {
        name: "401_bad_key",
        run: () => collect(new AnthropicAdapter("sk-ant-definitely-not-valid").stream({
          model: CHEAP, messages: [{ role: "user", content: "hi" }], maxTokens: 8 })),
        expectRetryable: false,
      },
      {
        name: "404_bad_model",
        run: () => collect(adapter.stream({ model: "claude-does-not-exist", messages: [{ role: "user", content: "hi" }], maxTokens: 8 })),
        expectRetryable: false,
      },
      {
        name: "400_bad_request",
        // max_tokens=0 은 스펙 위반 → 400
        run: () => collect(adapter.stream({ model: CHEAP, messages: [{ role: "user", content: "hi" }], maxTokens: 0 })),
        expectRetryable: false,
      },
      {
        name: "400_empty_messages",
        run: () => collect(adapter.stream({ model: CHEAP, messages: [], maxTokens: 32 })),
        expectRetryable: false,
      },
    ];
    for (const c of cases) {
      let err: unknown = null;
      try { await c.run(); } catch (e) { err = e; }
      const ok = err instanceof ProviderError && err.retryable === c.expectRetryable;
      r.check(`error.${c.name}`, ok,
        err instanceof ProviderError
          ? `ProviderError retryable=${err.retryable} — ${err.message.slice(0, 80)}`
          : `expected ProviderError, got ${err instanceof Error ? err.message.slice(0, 80) : "no error"}`);
    }

    // 에러가 절대 사용자 텍스트로 위장되지 않는가 (조용한 실패 금지)
    let silent = false;
    try {
      const res = await collect(adapter.stream({ model: "claude-does-not-exist", messages: [{ role: "user", content: "hi" }], maxTokens: 8 }));
      silent = res.text.length > 0;
    } catch { /* expected */ }
    r.check("error.never_silent", !silent, "a failed request never yields partial text as if it succeeded");
  });

  // ---------- 2.7 Timeout / cancellation ----------
  r.section("2.7 Timeout & cancellation");
  await r.guard("timeout", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 600);
    let aborted = false;
    let received = 0;
    try {
      for await (const ev of adapter.stream({
        model: MODEL,
        messages: [{ role: "user", content: "Write a 2000-word essay about distributed consensus." }],
        maxTokens: 16_000, abortSignal: ac.signal,
      })) {
        if (ev.type === "text_delta") received++;
      }
    } catch { aborted = true; }
    const ms = Date.now() - t0;
    r.check("timeout.abort_honored", aborted && ms < 6_000, `aborted after ${ms}ms with ${received} deltas consumed`);

    // 중간에 끊긴 뒤에도 어댑터가 재사용 가능한가 (상태 오염 없음)
    const after = await collect(adapter.stream({
      model: CHEAP, messages: [{ role: "user", content: "Reply with exactly: STILL-WORKS" }], maxTokens: 64, reasoning: "off",
    }));
    r.check("timeout.adapter_reusable", after.text.includes("STILL-WORKS"), `"${after.text.trim()}"`);
  });

  // ---------- 2.8 Rate limit ----------
  r.section("2.8 Rate limit behaviour");
  await r.guard("ratelimit", async () => {
    // 짧은 요청을 강하게 몰아쳐 429를 유도한다. 429가 나지 않아도 '한도 내에서 안정적'이라는
    // 사실 자체가 결과다 — 중요한 건 429가 났을 때 retryable=true 로 분류되는지다.
    const N = 40;
    const t0 = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        collect(adapter.stream({
          model: CHEAP, messages: [{ role: "user", content: `Reply with only the number ${i}.` }],
          maxTokens: 32, reasoning: "off",
        })),
      ),
    );
    const ok = results.filter((x) => x.status === "fulfilled").length;
    const failures = results.filter((x) => x.status === "rejected").map((x) => (x).reason);
    const rateLimited = failures.filter((e) => e instanceof ProviderError && e.status === 502 && /429|rate/i.test(e.message));
    const elapsed = Date.now() - t0;

    console.log(`    ${N} concurrent requests in ${elapsed}ms — ${ok} ok, ${failures.length} failed (${rateLimited.length} rate-limited)`);
    r.check("ratelimit.burst_survivable", ok > 0, `${ok}/${N} succeeded under a ${N}-way burst`);
    r.check("ratelimit.classified_retryable",
      rateLimited.length === 0 || rateLimited.every((e: ProviderError) => e.retryable),
      rateLimited.length === 0
        ? "no 429 observed at this concurrency (limit not reached) — classification verified by unit test"
        : `${rateLimited.length} rate-limit errors, all marked retryable → router will fail over`);
    r.check("ratelimit.no_unclassified_failures",
      failures.every((e) => e instanceof ProviderError),
      failures.length === 0 ? "no failures" : `failure types: ${[...new Set(failures.map((e) => (e as Error).constructor.name))].join(", ")}`);
  });

  // ---------- 2.9 Retry / failover (라우터 경유) ----------
  r.section("2.9 Retry & failover");
  await r.guard("retry", async () => {
    let attempts = 0;
    // 처음 두 번은 529(overloaded)로 실패하고 세 번째에 성공하는 어댑터
    const flaky = {
      id: "openai" as const,
      async *stream(req: Parameters<AnthropicAdapter["stream"]>[0]): AsyncGenerator<StreamEvent> {
        attempts++;
        if (attempts <= 2) throw new ProviderError("openai", "overloaded", { status: 529 });
        yield { type: "text_delta", text: "FLAKY-RECOVERED" };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } };
        yield { type: "done", stopReason: "end_turn" };
        void req;
      },
    };
    // 폴백 경로를 실제로 밟게 하려면 고장난 모델이 1순위여야 한다.
    // (단가를 낮춰 cheap 라우팅에서 확실히 먼저 선택되도록 만든다. 이 설정을 빼면
    //  라우터가 정상 모델을 먼저 골라 폴백이 한 번도 실행되지 않은 채 테스트가 통과한다 —
    //  이번 스프린트에서 실제로 겪은 거짓 PASS다.)
    const cheapInfo = findModel(CHEAP)!;
    const router = new AiRouter(
      { anthropic: adapter, openai: flaky },
      {
        catalog: [
          cheapInfo,
          { ...cheapInfo, provider: "openai", id: "flaky-model", inputCostPerMTok: 0.01, outputCostPerMTok: 0.01 },
        ],
      },
    );
    const preferred = router.rank({ taskClass: "cheap" })[0]!;
    r.check("retry.broken_model_ranked_first", preferred.id === "flaky-model",
      `router picks ${preferred.id} first — the failover path will actually be exercised`);

    const evs: StreamEvent[] = [];
    for await (const ev of router.stream({ messages: [{ role: "user", content: "Reply with exactly: RETRY-OK" }], maxTokens: 64 }, { taskClass: "cheap" })) {
      evs.push(ev);
    }
    const routed = evs.filter((e) => e.type === "routed").map((e) => (e as { provider: string }).provider);
    const text = evs.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    r.check("retry.failover_on_529",
      routed[0] === "openai" && routed.includes("anthropic") && text.length > 0,
      `routing chain: ${routed.join(" → ")}, ${attempts} attempt(s) on the broken provider, answer="${text.trim().slice(0, 40)}"`);
    r.check("retry.no_data_loss", !text.includes("undefined") && !text.includes("FLAKY"),
      "the recovered response comes entirely from the healthy provider, with no partial output from the failed attempt");
  });

  // ---------- 2.10 와이어 로그 무결성 ----------
  r.section("2.10 Wire log");
  {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(LOG, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as { direction: string; headers?: Record<string, string> });
    const requests = parsed.filter((p) => p.direction === "request").length;
    const responses = parsed.filter((p) => p.direction === "response").length;
    r.check("wirelog.captured", requests > 40 && responses > 40, `${requests} requests / ${responses} responses recorded`);
    r.check("wirelog.no_secret_leak", !raw.includes(KEY!) && !/sk-ant-api03-[A-Za-z0-9_-]{20}/.test(raw),
      "API key never appears in the log (headers redacted)");
    r.check("wirelog.all_parseable", parsed.length === lines.length, `${lines.length} JSONL records, all valid JSON`);
    console.log(`    log size: ${(raw.length / 1024).toFixed(0)} KB at ${LOG}`);
  }
} catch (err) {
  // 최상위에서 새는 예외(가드 밖의 섹션)도 계정 문제면 BLOCKED로 분류되도록 report에 위임한다.
  await r.guard("s2-claude.uncaught", () => Promise.reject(err instanceof Error ? err : new Error(String(err))));
} finally {
  wire.uninstall();
}

r.finish();
