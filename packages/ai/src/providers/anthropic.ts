import { ProviderError } from "@aios/shared";
import type { ChatMessage, CompletionRequest, ProviderId, StreamEvent } from "@aios/shared";
import { parseSse } from "../sse.js";
import { readErrorBody, wrapNetworkError, type ProviderAdapter } from "../adapter.js";

/** 우리가 실제로 읽는 필드만 선언한 Anthropic SSE 이벤트 (전체 스펙의 부분집합) */
interface AnthropicStreamEvent {
  type: string;
  /** content_block_* 이벤트에만 존재. 해당 이벤트에서는 항상 존재하므로 ?? -1 로 방어만 한다. */
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Anthropic Messages API 어댑터.
 * 포맷 차이의 핵심: 도구 결과가 별도 role이 아니라 user 메시지의 tool_result 블록이고,
 * 도구 호출 인자는 input_json_delta 로 스트리밍된다.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id: ProviderId = "anthropic";
  private baseUrl = "https://api.anthropic.com/v1";

  constructor(private apiKey: string) {}

  private toWire(req: CompletionRequest): Record<string, unknown> {
    // thinking 처리 — 최신 Claude 모델은 사고가 기본 ON이고 max_tokens가 사고+응답을 함께 제한한다.
    //  reasoning="off" → 명시적 비활성화 (지연·비용 우선 작업)
    //  reasoning="auto"/미지정 → 사고 유지하되, 사고 내용을 요약해 받아 UI가 진행 상황을 보여줄 수 있게 한다
    //    (기본값 display="omitted"는 빈 thinking 블록만 흘러 사용자에게 긴 정적으로 보인다)
    const thinking =
      req.reasoning === "off"
        ? { type: "disabled" }
        : { type: "adaptive", display: "summarized" };

    return {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      thinking,
      ...(req.system ? { system: req.system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: mapMessages(req.messages),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.toWire(req)),
      signal: req.abortSignal ?? null,
    }).catch((err: unknown) => wrapNetworkError(this.id, err));
    if (!res.ok || !res.body) {
      throw new ProviderError(this.id, await readErrorBody(res), { status: res.status });
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let stop: string | null = null;
    // content block index → 누적 중인 tool_use
    const blocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const msg of parseSse(res.body)) {
      // Anthropic 스트림 이벤트는 type에 따라 형태가 완전히 달라진다(9종).
      // 전부 타이핑하면 SDK를 재구현하는 셈이 되고, 프로바이더가 필드를 추가할 때마다
      // 우리 타입이 거짓말이 된다. 우리가 읽는 경로만 좁게 선언한다.
      const ev = JSON.parse(msg.data) as AnthropicStreamEvent;
      switch (ev.type) {
        case "message_start":
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") {
            blocks.set(ev.index ?? -1, { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "" });
          }
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            yield { type: "text_delta", text: ev.delta.text as string };
          } else if (ev.delta?.type === "thinking_delta") {
            // 사고는 별도 이벤트로 — 최종 답변과 섞이면 사용자에게 노이즈가 된다
            yield { type: "thinking_delta", text: ev.delta.thinking as string };
          } else if (ev.delta?.type === "input_json_delta") {
            const b = blocks.get(ev.index ?? -1);
            if (b) b.json += ev.delta.partial_json as string;
          }
          break;
        case "content_block_stop": {
          const b = blocks.get(ev.index ?? -1);
          if (b) {
            blocks.delete(ev.index ?? -1);
            yield {
              type: "tool_call",
              call: { id: b.id, name: b.name, arguments: parseArgs(b.json) },
            };
          }
          break;
        }
        case "message_delta":
          stop = ev.delta?.stop_reason ?? stop;
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
          break;
        case "error":
          throw new ProviderError(this.id, JSON.stringify(ev.error), {
            status: ev.error?.type === "overloaded_error" ? 529 : 500,
          });
      }
    }

    yield { type: "usage", usage: { inputTokens, outputTokens } };
    yield {
      type: "done",
      stopReason: stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : "end_turn",
    };
  }
}

function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system은 최상위 필드로 승격됨
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      // Anthropic은 연속된 동일 role 메시지를 거부하므로 직전 user 메시지에 병합
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return { __raw: json };
  }
}
