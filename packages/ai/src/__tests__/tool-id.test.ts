/**
 * Phase 5 회귀: 도구 결과 ID.
 *
 * 버그: Gemini의 이름 기반 매칭을 위해 toolCallId에 "id::name" 복합키를 썼더니
 * Anthropic이 400을 반환했다 (tool_use_id는 ^[a-zA-Z0-9_-]+$ 만 허용).
 * 모든 Claude 도구 루프가 첫 도구 결과에서 깨졌다.
 *
 * 계약: toolCallId는 프로바이더가 준 원본 id 그대로여야 하고,
 * Gemini 어댑터는 대화에서 id→이름을 역인덱싱해 스스로 해결해야 한다.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@aios/shared";
import { GeminiAdapter } from "../providers/gemini.js";

const ANTHROPIC_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

/** private toWire를 거치지 않고 검증하려고 실제 요청 바디를 가로챈다 */
async function captureBody(messages: ChatMessage[]): Promise<Record<string, any>> {
  const original = globalThis.fetch;
  let captured: Record<string, any> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, any>;
    return new Response("", { status: 500 });
  }) as typeof fetch;
  try {
    const adapter = new GeminiAdapter("test-key");
    for await (const _ of adapter.stream({ model: "gemini-2.5-flash", messages })) { /* drain */ }
  } catch {
    /* 500을 일부러 반환했으므로 예외는 예상된 것 */
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

describe("tool result id 계약", () => {
  const conversation: ChatMessage[] = [
    { role: "user", content: "weather in Seoul?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_01ABCdef", name: "get_weather", arguments: { city: "Seoul" } }],
    },
    { role: "tool", content: "18C clear", toolCallId: "toolu_01ABCdef" },
  ];

  it("도구 결과 id가 Anthropic의 허용 패턴을 만족한다", () => {
    const toolMsg = conversation.find((m) => m.role === "tool")!;
    expect(toolMsg.toolCallId).toMatch(ANTHROPIC_TOOL_ID);
    expect(toolMsg.toolCallId).not.toContain("::");
  });

  it("Gemini 어댑터가 순수 id에서 함수 이름을 복원한다", async () => {
    const body = await captureBody(conversation);
    const parts = body.contents?.flatMap((c: { parts?: unknown[] }) => c.parts ?? []) ?? [];
    const fnResponse = parts.find((p: { functionResponse?: unknown }) => p.functionResponse) as
      | { functionResponse: { name: string; response: { result: string } } }
      | undefined;
    expect(fnResponse?.functionResponse.name).toBe("get_weather");
    expect(fnResponse?.functionResponse.response.result).toBe("18C clear");
  });

  it("짝이 없는 id는 이름을 만들어내지 않고 안전한 기본값으로 떨어진다", async () => {
    const orphan: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "tool", content: "result", toolCallId: "unknown_id" },
    ];
    const body = await captureBody(orphan);
    const parts = body.contents?.flatMap((c: { parts?: unknown[] }) => c.parts ?? []) ?? [];
    const fnResponse = parts.find((p: { functionResponse?: unknown }) => p.functionResponse) as
      | { functionResponse: { name: string } }
      | undefined;
    expect(fnResponse?.functionResponse.name).toBe("tool");
  });
});
