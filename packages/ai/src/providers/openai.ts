import { ProviderError } from "@aios/shared";
import type { ChatMessage, CompletionRequest, ProviderId, StreamEvent, ToolCall } from "@aios/shared";
import { parseSse } from "../sse.js";
import { readErrorBody, wrapNetworkError, type ProviderAdapter } from "../adapter.js";

/**
 * OpenAI Chat Completions 어댑터.
 * Responses API가 아닌 Chat Completions를 쓰는 이유: xAI(Grok)가 이 표면과 호환되어
 * 어댑터 하나로 두 프로바이더를 커버한다. 필요 기능(스트리밍/도구/usage)은 전부 지원된다.
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly id: ProviderId = "openai";
  protected baseUrl = "https://api.openai.com/v1";
  /**
   * HTTP 호출 지점. 기본은 Node 내장 fetch 다.
   *
   * 왜 갈아끼울 수 있게 두는가: 내장 fetch 는 undici 기본값을 쓰고 **헤더 타임아웃이 300초**로
   * 고정돼 있으며 바꿀 방법이 없다. 클라우드 프로바이더에는 그게 맞다 — 5분간 헤더도 못 보내면
   * 그건 진짜 장애다. 하지만 로컬 추론에서는 300초가 정상 대기 시간일 수 있다.
   * 그 차이를 프로바이더별로 다루려면 여기 한 곳만 바꿀 수 있으면 된다.
   */
  protected fetchImpl: typeof fetch = fetch;

  constructor(protected apiKey: string) {}

  protected headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  protected toWire(req: CompletionRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(mapMessage(m));
    return {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.toWire(req)),
      signal: req.abortSignal ?? null,
    }).catch((err: unknown) => wrapNetworkError(this.id, err));
    if (!res.ok || !res.body) {
      throw new ProviderError(this.id, await readErrorBody(res), { status: res.status });
    }

    // 도구 호출 인자는 델타로 쪼개져 오므로 index별로 누적한다
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;

    for await (const msg of parseSse(res.body)) {
      if (msg.data === "[DONE]") break;
      const chunk = JSON.parse(msg.data) as {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens: number; completion_tokens: number } | null;
      };

      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { type: "text_delta", text: choice.delta.content };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(tc.index, cur);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        yield {
          type: "usage",
          usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens },
        };
      }
    }

    for (const [, tc] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", call: { id: tc.id, name: tc.name, arguments: safeJson(tc.args) } };
    }
    yield {
      type: "done",
      stopReason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    };
  }

  async embed(texts: string[], model = "text-embedding-3-small"): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: texts }),
    }).catch((err: unknown) => wrapNetworkError(this.id, err));
    if (!res.ok) throw new ProviderError(this.id, await readErrorBody(res), { status: res.status });
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

function mapMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c: ToolCall) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    // 모델이 잘린 JSON을 뱉는 경우가 실존한다. 도구 실행 전에 zod 검증이 한 번 더 있으므로
    // 여기서는 원문을 보존해 디버깅 가능성을 남긴다.
    return { __raw: s };
  }
}
