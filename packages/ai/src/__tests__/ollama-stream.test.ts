import { describe, expect, it, vi } from "vitest";
import { ollamaStream } from "../providers/ollama-stream.js";
import type { CompletionRequest, StreamEvent } from "@aios/shared";
const req: CompletionRequest = { model: "local", reasoning: "off", messages: [{ role: "user", content: "안녕" }], maxTokens: 100 };
const drain = async (stream: AsyncGenerator<StreamEvent>) => { const events: StreamEvent[] = []; for await (const event of stream) events.push(event); return events; };
function response(lines: unknown[], split = false) {
  const bytes = new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));
  return new Response(new ReadableStream({ start(controller) { if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); else controller.enqueue(bytes); controller.close(); } }));
}
describe("Ollama 네이티브 스트림", () => {
  it("한글 바이트 경계/마지막 줄과 ns→ms 계측을 처리한다", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([{ message: { content: "안녕" } }, { done: true, load_duration: 2_000_000, prompt_eval_duration: 3_000_000, eval_duration: 4_000_000, total_duration: 10_000_000, prompt_eval_count: 12, eval_count: 2 }], true));
    const events = await drain(ollamaStream(fetcher, "http://localhost:11434/v1", {}, req, 8192));
    const wire = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(fetcher.mock.calls[0]![0]).toBe("http://localhost:11434/api/chat");
    expect(wire).toMatchObject({ think: false, options: { num_ctx: 8192, num_predict: 100 } });
    expect(events).toContainEqual({ type: "text_delta", text: "안녕" });
    expect(events).toContainEqual({ type: "timing", phase: "model_load", durationMs: 2 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    // 결함 주입: ns를 ms로 오인하면 같은 계약 검사에서 실패한다.
    expect(() => expect({ durationMs: 2_000_000 }).toMatchObject({ durationMs: 2 })).toThrow();
  });
  it("도구 호출 인자와 후속 결과의 도구 이름을 보존한다", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([{ message: { tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] } }, { done: true }]));
    const events = await drain(ollamaStream(fetcher, "http://local/v1", {}, req));
    const call = events.find((e) => e.type === "tool_call");
    if (call?.type !== "tool_call") throw new Error("missing call");
    expect(call.call).toMatchObject({ name: "read_file", arguments: { path: "a.ts" } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
    await drain(ollamaStream(fetcher, "http://local/v1", {}, { ...req, messages: [{ role: "assistant", content: "", toolCalls: [call.call] }, { role: "tool", content: "file data", toolCallId: call.call.id }] }));
    const wire = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(wire.messages[1]).toMatchObject({ role: "tool", tool_name: "read_file", content: "file data" });
  });
  it("결함 주입: 정상 종료가 유실된 스트림을 성공으로 처리하지 않는다", async () => {
    await expect(drain(ollamaStream(async () => response([{ message: { content: "partial" } }]), "http://local/v1", {}, req))).rejects.toThrow("incomplete");
    await expect(drain(ollamaStream(async () => response([{ error: "model failed" }]), "http://local/v1", {}, req))).rejects.toThrow("model failed");
  });
  it("출력 한도로 잘린 도구 호출을 실행 가능한 완료로 처리하지 않는다", async () => {
    const events = await drain(ollamaStream(async () => response([{ message: { tool_calls: [{ function: { name: "write_file", arguments: { path: "a" } } }] }, done: true, done_reason: "length" }]), "http://local/v1", {}, req));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
  });
  it("취소 신호를 실제 요청에 전달하고 중단한다", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => { abort.abort(); return response([{ done: true }]); });
    await expect(drain(ollamaStream(fetcher, "http://local/v1", {}, { ...req, abortSignal: abort.signal }))).rejects.toThrow();
    expect(fetcher.mock.calls[0]![1]!.signal).toBe(abort.signal);
  });
});
