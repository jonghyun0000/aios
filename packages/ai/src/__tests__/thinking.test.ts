/**
 * thinking 채널 파싱의 결정론적 검증.
 *
 * 왜 라이브 하네스가 아니라 여기인가:
 * adaptive thinking은 '모델이 사고할지 말지를 매번 결정'한다. 같은 프롬프트로 두 번 돌리면
 * 한 번은 사고하고 한 번은 안 한다(Sprint 2에서 실제로 관측). 그런 비결정론적 신호를
 * CI 게이트로 쓰면 테스트가 무작위로 빨개지고, 결국 사람들이 테스트를 믿지 않게 된다.
 * 따라서: 파싱 경로는 녹화된 프레임으로 여기서 결정론적으로 검증하고,
 * 라이브 하네스는 "사고가 왔다면 답변과 섞이지 않는다"는 불변식만 확인한다.
 */
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@aios/shared";
import { AnthropicAdapter } from "../providers/anthropic.js";

/** 실제 Anthropic SSE 프레임 형식 그대로 (Sprint 2 와이어 로그에서 채취) */
function sseFixture(frames: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
}

async function runAdapter(frames: object[], reqOverrides: Record<string, unknown> = {}): Promise<{
  events: StreamEvent[];
  body: Record<string, unknown>;
}> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    return new Response(sseFixture(frames), { status: 200 });
  }) as typeof fetch;
  try {
    const adapter = new AnthropicAdapter("test-key");
    const events: StreamEvent[] = [];
    for await (const ev of adapter.stream({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "q" }],
      maxTokens: 4096,
      ...reqOverrides,
    })) {
      events.push(ev);
    }
    return { events, body };
  } finally {
    globalThis.fetch = original;
  }
}

const THINKING_STREAM = [
  { type: "message_start", message: { usage: { input_tokens: 42 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me work through " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the switch puzzle." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Turn on switch one" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " for ten minutes." } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 99 } },
];

describe("thinking 채널", () => {
  it("thinking_delta를 별도 이벤트로 내보내고 답변 텍스트와 섞지 않는다", async () => {
    const { events } = await runAdapter(THINKING_STREAM);
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => (e as { text: string }).text).join("");
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    expect(thinking).toBe("Let me work through the switch puzzle.");
    expect(text).toBe("Turn on switch one for ten minutes.");
    // 핵심 불변식: 사고가 답변에 섞이면 사용자가 내부 추론을 최종 답변으로 읽게 된다
    expect(text).not.toContain("Let me work through");
  });

  it("usage와 stopReason을 사고 블록이 있어도 정확히 집계한다", async () => {
    const { events } = await runAdapter(THINKING_STREAM);
    const usage = events.find((e) => e.type === "usage") as { usage: { inputTokens: number; outputTokens: number } };
    const done = events.find((e) => e.type === "done") as { stopReason: string };
    expect(usage.usage).toEqual({ inputTokens: 42, outputTokens: 99 });
    expect(done.stopReason).toBe("end_turn");
  });

  it("reasoning='off'이면 thinking을 disabled로 요청한다", async () => {
    const { body } = await runAdapter(THINKING_STREAM, { reasoning: "off" });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("기본값은 adaptive + summarized (빈 사고 블록으로 인한 긴 정적을 피한다)", async () => {
    const { body } = await runAdapter(THINKING_STREAM);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("사고 없이 도착한 스트림도 정상 처리한다 (adaptive가 사고를 생략한 경우)", async () => {
    const { events } = await runAdapter([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "42" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ]);
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(1);
    expect((events.find((e) => e.type === "done") as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("사고 블록과 도구 호출이 함께 와도 인덱스를 혼동하지 않는다", async () => {
    const { events } = await runAdapter([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "need weather" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_abc", name: "get_weather" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Seoul"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    ]);
    const call = events.find((e) => e.type === "tool_call") as { call: { id: string; name: string; arguments: Record<string, unknown> } };
    expect(call.call).toEqual({ id: "toolu_abc", name: "get_weather", arguments: { city: "Seoul" } });
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
    // 사고 블록(index 0)이 도구 블록(index 1)의 누적을 오염시키지 않았다
    expect((events.find((e) => e.type === "done") as { stopReason: string }).stopReason).toBe("tool_use");
  });
});
