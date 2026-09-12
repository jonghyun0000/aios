/**
 * Phase 1 — Claude API 연결 검증 하네스.
 *
 * 검증 항목: 연결 / 스트리밍 / 도구호출 / 컨텍스트윈도우 / 토큰사용량 / 재시도 / 타임아웃.
 * 실제 Anthropic API를 호출한다(비용 발생). 각 검사는 PASS/FAIL을 stdout에 출력하고,
 * 하나라도 FAIL이면 프로세스 exit code 1.
 */
import { AnthropicAdapter, AiRouter, MODEL_CATALOG, costUsd, findModel } from "@aios/ai";
import { estimateTokens, ProviderError } from "@aios/shared";
import type { StreamEvent, ToolSpec } from "@aios/shared";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const adapter = new AnthropicAdapter(KEY);
const MODEL = "claude-sonnet-5";

// ---------- 1.1 기본 연결 ----------
console.log("\n[1.1] 기본 연결 (non-tool, 단문)");
{
  const t0 = Date.now();
  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let stop = "";
  for await (const ev of adapter.stream({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: AIOS-OK" }],
    maxTokens: 32,
  })) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "usage") usage = ev.usage;
    if (ev.type === "done") stop = ev.stopReason;
  }
  const ms = Date.now() - t0;
  record("connect", text.includes("AIOS-OK"), `resp="${text.trim()}" stop=${stop} ${ms}ms`);
  record("usage", !!usage && usage.inputTokens > 0 && usage.outputTokens > 0,
    usage ? `in=${usage.inputTokens} out=${usage.outputTokens}` : "no usage event");
}

// ---------- 1.2 스트리밍: 델타가 실제로 여러 개로 쪼개져 오는가 ----------
console.log("\n[1.2] 스트리밍 (증분 델타 + TTFT)");
{
  const t0 = Date.now();
  let ttft = 0;
  let deltas = 0;
  let chars = 0;
  // 긴 출력을 요구해야 증분 전달이 관찰된다 — 짧은 응답은 서버가 1~2개 청크로 묶어 보낸다.
  for await (const ev of adapter.stream({
    model: MODEL,
    messages: [{ role: "user", content: "Write 200 words about database indexing. Plain prose." }],
    maxTokens: 600,
  })) {
    if (ev.type === "text_delta") {
      if (deltas === 0) ttft = Date.now() - t0;
      deltas++;
      chars += ev.text.length;
    }
  }
  record("streaming.incremental", deltas > 3, `${deltas} deltas, ${chars} chars`);
  record("streaming.ttft", ttft > 0 && ttft < 30_000, `TTFT=${ttft}ms, total=${Date.now() - t0}ms`);
}

// ---------- 1.3 도구 호출 (single + parallel) ----------
console.log("\n[1.3] Tool Calling");
const weatherTool: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};
{
  const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  let stop = "";
  for await (const ev of adapter.stream({
    model: MODEL,
    messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
    tools: [weatherTool],
    maxTokens: 512,
  })) {
    if (ev.type === "tool_call") calls.push(ev.call);
    if (ev.type === "done") stop = ev.stopReason;
  }
  const ok = calls.length === 1 && calls[0]!.name === "get_weather" && typeof calls[0]!.arguments.city === "string";
  record("tool.single", ok, `stop=${stop} calls=${JSON.stringify(calls.map((c) => ({ n: c.name, a: c.arguments })))}`);

  // 도구 결과 주입 후 루프 재개 — 대화 재구성이 올바른지 검증하는 핵심 케이스
  if (calls.length > 0) {
    let final = "";
    for await (const ev of adapter.stream({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Seoul? Use the tool." },
        { role: "assistant", content: "", toolCalls: calls },
        { role: "tool", content: "18°C, clear sky", toolCallId: calls[0]!.id },
      ],
      tools: [weatherTool],
      maxTokens: 256,
    })) {
      if (ev.type === "text_delta") final += ev.text;
    }
    record("tool.result_roundtrip", /18/.test(final), `final="${final.trim().slice(0, 100)}"`);
  } else {
    record("tool.result_roundtrip", false, "skipped: no tool call to respond to");
  }
}

// ---------- 1.4 병렬 도구 호출 ----------
console.log("\n[1.4] Parallel tool calls");
{
  const calls: string[] = [];
  for await (const ev of adapter.stream({
    model: MODEL,
    messages: [{ role: "user", content: "Get weather for Seoul AND Tokyo. Call the tool for both." }],
    tools: [weatherTool],
    maxTokens: 512,
  })) {
    if (ev.type === "tool_call") calls.push(JSON.stringify(ev.call.arguments));
  }
  record("tool.parallel", calls.length >= 2, `${calls.length} calls: ${calls.join(", ")}`);
}

// ---------- 1.5 컨텍스트 윈도우 ----------
console.log("\n[1.5] Context window");
{
  const info = findModel(MODEL)!;
  // 카탈로그 값이 실제 API와 일치하는지: 큰 입력을 실제로 보내 확인 (~40k 토큰)
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(4000);
  const est = estimateTokens(filler);
  let out = "";
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  try {
    for await (const ev of adapter.stream({
      model: MODEL,
      messages: [
        { role: "user", content: `${filler}\n\nIgnore the text above. Reply with exactly: BIGCTX-OK` },
      ],
      maxTokens: 32,
    })) {
      if (ev.type === "text_delta") out += ev.text;
      if (ev.type === "usage") usage = ev.usage;
    }
    const drift = usage ? Math.abs(usage.inputTokens - est) / usage.inputTokens : 1;
    record("context.large_input", out.includes("BIGCTX-OK"),
      `sent~${est} est tokens, actual=${usage?.inputTokens}, estimator drift=${(drift * 100).toFixed(1)}%`);
    record("context.catalog_window", info.contextWindow >= (usage?.inputTokens ?? 0),
      `catalog=${info.contextWindow} >= used=${usage?.inputTokens}`);
  } catch (err) {
    record("context.large_input", false, String(err).slice(0, 200));
  }
}

// ---------- 1.6 토큰 사용량 & 비용 계산 ----------
console.log("\n[1.6] Token usage → cost");
{
  const info = findModel(MODEL)!;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  for await (const ev of adapter.stream({
    model: MODEL,
    messages: [{ role: "user", content: "Write one sentence about databases." }],
    maxTokens: 100,
  })) {
    if (ev.type === "usage") usage = ev.usage;
  }
  const cost = usage ? costUsd(info, usage.inputTokens, usage.outputTokens) : -1;
  record("usage.cost_calc", cost > 0 && cost < 0.01,
    `in=${usage?.inputTokens} out=${usage?.outputTokens} → $${cost.toFixed(6)}`);
}

// ---------- 1.7 에러/재시도 판정 ----------
console.log("\n[1.7] Error classification & retry");
{
  // 잘못된 키 → 401 → retryable=false 여야 한다 (폴백 대상이 아님)
  const bad = new AnthropicAdapter("sk-ant-invalid-key-for-test");
  let err: unknown;
  try {
    for await (const _ of bad.stream({ model: MODEL, messages: [{ role: "user", content: "hi" }], maxTokens: 8 })) {
      /* drain */
    }
  } catch (e) {
    err = e;
  }
  const isProviderErr = err instanceof ProviderError;
  record("error.401_not_retryable", isProviderErr && !(err as ProviderError).retryable,
    isProviderErr ? `retryable=${(err as ProviderError).retryable}` : `unexpected: ${String(err).slice(0, 80)}`);

  // 존재하지 않는 모델 → 404 → non-retryable
  let err2: unknown;
  try {
    for await (const _ of adapter.stream({ model: "claude-nonexistent-9", messages: [{ role: "user", content: "hi" }], maxTokens: 8 })) {
      /* drain */
    }
  } catch (e) {
    err2 = e;
  }
  record("error.404_not_retryable", err2 instanceof ProviderError && !(err2).retryable,
    err2 instanceof ProviderError ? `retryable=${(err2).retryable}` : String(err2).slice(0, 80));
}

// ---------- 1.8 타임아웃 (AbortSignal) ----------
console.log("\n[1.8] Timeout / cancellation");
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 700);
  let aborted = false;
  let received = 0;
  const t0 = Date.now();
  try {
    for await (const ev of adapter.stream({
      model: MODEL,
      messages: [{ role: "user", content: "Write a 1500-word essay about distributed systems." }],
      maxTokens: 4000,
      abortSignal: ac.signal,
    })) {
      if (ev.type === "text_delta") received++;
    }
  } catch {
    aborted = true;
  }
  const ms = Date.now() - t0;
  record("timeout.abort_honored", aborted && ms < 5000, `aborted after ${ms}ms, ${received} deltas received`);
}

// ---------- 1.9 라우터 통합 (실제 Claude 경유) ----------
console.log("\n[1.9] Router integration");
{
  const router = new AiRouter({ anthropic: adapter });
  const events: StreamEvent[] = [];
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "Reply with exactly: ROUTER-OK" }], maxTokens: 32 },
    { taskClass: "code" },
  )) {
    events.push(ev);
  }
  const routed = events.find((e) => e.type === "routed") as { model: string } | undefined;
  const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  const usage = events.find((e) => e.type === "usage") as { usage: { costUsd?: number } } | undefined;
  record("router.selects_and_streams", text.includes("ROUTER-OK"), `model=${routed?.model} text="${text.trim()}"`);
  record("router.cost_annotation", (usage?.usage.costUsd ?? 0) > 0, `costUsd=${usage?.usage.costUsd}`);
  // 카탈로그의 anthropic 모델이 전부 실제 존재하는 ID인지 확인은 1.10에서
}

// ---------- 1.10 카탈로그 ID 실존 검증 ----------
console.log("\n[1.10] Catalog model IDs are resolvable at the provider");
{
  // /v1/models 목록은 정식 ID만 반환하고 alias(claude-haiku-4-5)는 빠져 있다.
  // 따라서 "목록에 있는가"가 아니라 "실제로 호출되는가"로 검증해야 한다.
  const ours = MODEL_CATALOG.filter((m) => m.provider === "anthropic").map((m) => m.id);
  const bad: string[] = [];
  for (const id of ours) {
    const res = await fetch(`https://api.anthropic.com/v1/models/${id}`, {
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) bad.push(`${id}(${res.status})`);
  }
  record("catalog.ids_valid", bad.length === 0,
    bad.length ? `unresolvable: ${bad.join(", ")}` : `all ${ours.length} anthropic IDs resolve`);
}

// ---------- 요약 ----------
const failed = results.filter((r) => !r.pass);
console.log("\n" + "=".repeat(70));
console.log(`PHASE 1: ${failed.length === 0 ? "PASS" : "FAIL"}  (${results.length - failed.length}/${results.length} checks)`);
if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(", "));
console.log("=".repeat(70));
process.exit(failed.length === 0 ? 0 : 1);
