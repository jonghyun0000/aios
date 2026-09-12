import { ApiError, apiKeyStore } from "./api.js";
import type { ChatMode, TimingPhase } from "../../../../packages/shared/src/types.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * SSE 스트리밍 채팅.
 *
 * EventSource를 쓸 수 없는 이유: 서버는 POST /v1/sessions/:id/messages 로 본문을 받는데
 * EventSource는 GET만 지원하고 헤더도 붙일 수 없다. 그래서 fetch + ReadableStream을 직접 읽는다.
 *
 * 프레임 파싱에서 주의할 점 (직접 겪지 않으면 놓치는 것들):
 *  - 청크 경계가 이벤트 경계와 일치하지 않는다. 버퍼에 모아 `\n\n`으로 잘라야 한다.
 *  - 서버가 15초마다 `: ping` 주석을 보낸다. `data:`로 시작하지 않는 줄은 무시해야 한다.
 *  - 스트림 도중 발생한 에러는 HTTP 상태를 바꿀 수 없어 `{type:"error"}` 이벤트로 온다.
 */

export type ChatEvent =
  | { type: "execution_update"; runId: string }
  | { type: "incomplete"; reason: string; attempt: number }
  | ({ type: "workspace_context" } & WorkspaceContext)
  | { type: "timing"; phase: TimingPhase; durationMs: number }
  | { type: "strategy"; mode: ChatMode; path: "fast" | "thorough" | "calculator"; reason: string }
  | { type: "context_trimmed"; sections: { section: string; count: number }[] }
  | { type: "routed"; provider: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; arguments: unknown } }
  | { type: "tool_start"; call: { id: string; name: string; arguments: unknown } }
  | { type: "tool_result"; id: string; ok: boolean; summary?: string }
  | { type: "commit"; sha: string; message: string }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { type: "done"; stopReason: string }
  | { type: "error"; code: string; message: string };

export interface SendOptions {
  sessionId: string;
  content: string;
  toolsEnabled?: boolean;
  verificationCommand?: string;
  mode?: ChatMode;
  useMemory?: boolean;
  signal?: AbortSignal;
  onEvent(event: ChatEvent): void;
}

export async function streamChat(opts: SendOptions): Promise<void> {
  const key = apiKeyStore.get();
  const res = await fetch(`/v1/sessions/${opts.sessionId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      content: opts.content,
      mode: opts.mode ?? "auto",
      tools: { enabled: opts.toolsEnabled ?? false },
      verificationCommand: opts.toolsEnabled ? opts.verificationCommand?.trim() || undefined : undefined,
      context: { useMemory: opts.useMemory !== false },
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    // 스트림이 시작되기 전의 실패(쿼터 초과, 세션 없음 등)는 평범한 JSON 에러다.
    const text = await res.text();
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch { /* 원문 유지 */ }
    throw new ApiError(res.status, code, message);
  }
  if (!res.body) throw new Error("스트림 본문이 없습니다");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let streamError = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue; // `: ping` 하트비트 등
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const event = JSON.parse(payload) as ChatEvent;
          if (event.type === "done" && event.stopReason !== "tool_use") {
            terminal = true;
            if (event.stopReason !== "end_turn" && !streamError) opts.onEvent({ type: "error", code: "execution_incomplete", message: "응답 또는 실행 검증이 정상 완료되지 않았습니다." });
          }
          if (event.type === "error") streamError = true;
          opts.onEvent(event);
        } catch {
          // 깨진 프레임 하나 때문에 스트림 전체를 버리지 않는다.
          opts.onEvent({ type: "error", code: "bad_frame", message: payload.slice(0, 200) });
        }
      }
    }
  }
  if (!terminal && !streamError) throw new Error("완료 확인 전에 연결이 끊겼습니다. 실행 기록과 저장된 답변을 확인해 주세요.");
}
