import { randomUUID } from "node:crypto";
import { ProviderError, type CompletionRequest, type StreamEvent, type TimingPhase } from "@aios/shared";
import { readErrorBody, wrapNetworkError } from "../adapter.js";

// Native API만 모델 적재/프롬프트/생성 시간을 제공한다. /v1 호환 경로는 그대로 보존한다.
// https://docs.ollama.com/api/chat (duration 단위: ns)
export async function* ollamaStream(fetchImpl: typeof fetch, baseUrl: string, headers: Record<string, string>, req: CompletionRequest, contextWindow?: number): AsyncGenerator<StreamEvent> {
  const names = new Map(req.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name] as const)));
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: m.content,
      ...(m.role === "tool" ? { tool_name: names.get(m.toolCallId ?? "") } : {}),
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}),
    })),
  ];
  const res = await fetchImpl(`${baseUrl.replace(/\/v1$/, "")}/api/chat`, {
    method: "POST", headers, signal: req.abortSignal ?? null,
    body: JSON.stringify({ model: req.model, messages, stream: true, think: req.reasoning !== "off",
      options: { ...(contextWindow ? { num_ctx: contextWindow } : {}), ...(req.maxTokens ? { num_predict: req.maxTokens } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })) } : {}),
    }),
  }).catch((err: unknown) => wrapNetworkError("local", err));
  if (!res.ok || !res.body) throw new ProviderError("local", await readErrorBody(res), { status: res.status });
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  let buffer = ""; let finished = false; let hasTools = false;
  try {
    while (!finished) {
      req.abortSignal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new ProviderError("local", "oversized stream frame");
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      if (done && buffer.trim()) { lines.push(buffer); buffer = ""; }
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as {
          error?: string; done?: boolean; done_reason?: string;
          message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
          prompt_eval_count?: number; eval_count?: number; load_duration?: number; prompt_eval_duration?: number; eval_duration?: number; total_duration?: number;
        };
        if (chunk.error) throw new ProviderError("local", chunk.error);
        if (chunk.message?.content) yield { type: "text_delta", text: chunk.message.content };
        for (const call of chunk.message?.tool_calls ?? []) {
          if (!call.function?.name || typeof call.function.arguments !== "object" || !call.function.arguments || Array.isArray(call.function.arguments)) throw new ProviderError("local", "invalid tool call");
          hasTools = true;
          yield { type: "tool_call", call: { id: randomUUID(), name: call.function.name, arguments: call.function.arguments } };
        }
        if (chunk.done) {
          finished = true;
          const fields: [TimingPhase, number | undefined][] = [["model_load", chunk.load_duration], ["prompt_eval", chunk.prompt_eval_duration], ["generation", chunk.eval_duration], ["server_total", chunk.total_duration]];
          for (const [phase, ns] of fields) if (ns !== undefined && Number.isFinite(ns) && ns >= 0) yield { type: "timing", phase, durationMs: ns / 1_000_000 };
          yield { type: "usage", usage: { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 } };
          yield { type: "done", stopReason: chunk.done_reason === "length" ? "max_tokens" : hasTools ? "tool_use" : "end_turn" };
          break;
        }
      }
      if (done) break;
    }
    if (!finished) throw new ProviderError("local", "incomplete Ollama stream");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
