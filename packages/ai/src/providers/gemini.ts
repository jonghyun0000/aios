import { ProviderError } from "@aios/shared";
import type { ChatMessage, CompletionRequest, ProviderId, StreamEvent } from "@aios/shared";
import { parseSse } from "../sse.js";
import { readErrorBody, wrapNetworkError, type ProviderAdapter } from "../adapter.js";

/**
 * Google Gemini(generateContent) 어댑터.
 * 포맷 차이의 핵심: role이 user/model 이원제, 도구는 functionCall/functionResponse parts,
 * 스트리밍은 ?alt=sse 로 SSE 강제.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly id: ProviderId = "gemini";
  private baseUrl = "https://generativelanguage.googleapis.com/v1beta";

  constructor(private apiKey: string) {}

  private toWire(req: CompletionRequest): Record<string, unknown> {
    return {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: mapContents(req.messages),
      generationConfig: {
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      ...(req.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              },
            ],
          }
        : {}),
    };
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const url = `${this.baseUrl}/models/${req.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(this.toWire(req)),
      signal: req.abortSignal ?? null,
    }).catch((err: unknown) => wrapNetworkError(this.id, err));
    if (!res.ok || !res.body) {
      throw new ProviderError(this.id, await readErrorBody(res), { status: res.status });
    }

    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let sawToolCall = false;
    let finish: string | null = null;
    let callSeq = 0;

    for await (const msg of parseSse(res.body)) {
      const chunk = JSON.parse(msg.data) as {
        candidates?: {
          content?: { parts?: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[] };
          finishReason?: string;
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (part.text) yield { type: "text_delta", text: part.text };
        if (part.functionCall) {
          sawToolCall = true;
          // Gemini는 call id를 주지 않으므로 우리가 부여한다 (대화 재구성 시 그대로 회수)
          yield {
            type: "tool_call",
            call: { id: `gem_${++callSeq}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} },
          };
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    }

    if (usage) yield { type: "usage", usage };
    yield {
      type: "done",
      stopReason: sawToolCall ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    };
  }

  async embed(texts: string[], model = "gemini-embedding-001"): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/models/${model}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
          outputDimensionality: 1536, // DB 스키마 vector(1536)와 일치시켜 프로바이더 교체 가능성 유지
        })),
      }),
    }).catch((err: unknown) => wrapNetworkError(this.id, err));
    if (!res.ok) throw new ProviderError(this.id, await readErrorBody(res), { status: res.status });
    const body = (await res.json()) as { embeddings: { values: number[] }[] };
    return body.embeddings.map((e) => e.values);
  }
}

function mapContents(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Gemini의 functionResponse는 call id가 아니라 '함수 이름'으로 호출과 짝지어진다.
  // 반면 다른 프로바이더는 id로 짝짓는다. 그래서 대화를 훑으며 id→name 맵을 만들어 둔다.
  // (이름을 toolCallId 문자열에 인코딩하지 않는 이유: Anthropic은 tool_use_id에
  //  ^[a-zA-Z0-9_-]+$ 만 허용하므로 구분자를 넣는 순간 400이 난다.)
  const nameById = new Map<string, string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) nameById.set(c.id, c.name);
  }

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: (m.toolCallId && nameById.get(m.toolCallId)) ?? "tool",
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.arguments } });
      out.push({ role: "model", parts });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  return out;
}
