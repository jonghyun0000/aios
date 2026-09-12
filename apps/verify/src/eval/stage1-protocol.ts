import { mkdir, writeFile } from "node:fs/promises";
import { LocalAdapter } from "@aios/ai";
import type { ChatMessage, CompletionRequest, StreamEvent, ToolCall } from "@aios/shared";

// 네이티브 전환의 실제 도구 왕복/중단 회귀. 도구는 메모리 안의 테스트 조회이며 파일을 쓰지 않는다.
const adapter = new LocalAdapter("http://127.0.0.1:11434/v1", "bge-m3", undefined, 4, 1, "ollama", 8192);
const results: { repeat: number; tools: boolean; cancellation: boolean; recovery: boolean }[] = [];
const drain = async (request: Partial<CompletionRequest> & Pick<CompletionRequest, "messages">) => {
  let text = ""; const calls: ToolCall[] = []; const events: StreamEvent[] = [];
  for await (const event of adapter.stream({ model: "qwen3:8b", reasoning: "off", maxTokens: 512, abortSignal: AbortSignal.timeout(120_000), ...request })) {
    events.push(event);
    if (event.type === "text_delta") text += event.text;
    if (event.type === "tool_call") calls.push(event.call);
  }
  return { text, calls, events };
};
for (let repeat = 1; repeat <= 3; repeat++) {
  const key = `sample-${repeat}`; const expected = String(700 + repeat);
  const user: ChatMessage = { role: "user", content: `Call lookup_number with key "${key}". Do not guess its result. Then reply only with its returned number.` };
  const tools = [{ name: "lookup_number", description: "Look up the exact number for a key.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }];
  const first = await drain({ messages: [user], tools });
  const call = first.calls[0];
  let toolsPass = false;
  if (call?.name === "lookup_number" && call.arguments.key === key && first.calls.length === 1) {
    const second = await drain({ tools, messages: [user, { role: "assistant", content: first.text, toolCalls: first.calls }, { role: "tool", content: expected, toolCallId: call.id }] });
    toolsPass = second.text.trim() === expected && second.calls.length === 0;
  }
  const abort = new AbortController(); let cancelled = false; let sawText = false;
  try {
    for await (const event of adapter.stream({ model: "qwen3:8b", reasoning: "off", maxTokens: 2048, messages: [{ role: "user", content: "List the integers from 1 to 10000, one per line." }], abortSignal: abort.signal })) {
      if (event.type === "text_delta") { sawText = true; abort.abort(); }
    }
  } catch { cancelled = abort.signal.aborted && sawText; }
  const recovered = await drain({ messages: [{ role: "user", content: "Reply with only OK." }] });
  const row = { repeat, tools: toolsPass, cancellation: cancelled, recovery: recovered.text.trim() === "OK" };
  results.push(row); console.log(JSON.stringify(row));
}
const dir = "/Volumes/T7/bigdata/eval-baselines/stage1";
await mkdir(dir, { recursive: true });
const file = `${dir}/protocol-${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ results }, null, 2));
console.log(JSON.stringify({ file }));
if (results.some((r) => !r.tools || !r.cancellation || !r.recovery)) process.exitCode = 1;
