/**
 * 시스템 전역 공유 타입. 서버·SDK·CLI·VSCode 확장이 전부 이 파일을 import 한다.
 * API 계약이 코드로 존재하므로 명세 드리프트는 컴파일 에러가 된다.
 */

// "local"은 사용자의 머신에서 도는 OpenAI 호환 추론 서버(Ollama 등)다.
// API 키 없이 제품 전체를 쓸 수 있게 하는 유일한 경로라 1급 프로바이더로 둔다.
export type ProviderId = "openai" | "anthropic" | "gemini" | "xai" | "local";

export type TaskClass = "chat" | "code" | "reasoning" | "summarize" | "cheap" | "vision";
export type ChatMode = "auto" | "fast" | "thorough";
export type TimingPhase = "save_input" | "context" | "client_queue" | "model_load" | "prompt_eval" | "generation" | "server_total" | "first_text" | "tools" | "save_output" | "total";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant 메시지의 도구 호출 */
  toolCalls?: ToolCall[];
  /** role=tool 일 때 어떤 호출의 결과인지 */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft-07 호환 서브셋) */
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

/** 4개 프로바이더의 스트림을 정규화한 단일 이벤트 타입 */
export type StreamEvent =
  | { type: "timing"; phase: TimingPhase; durationMs: number }
  | { type: "routed"; provider: ProviderId; model: string }
  | { type: "text_delta"; text: string }
  /** 모델의 사고 과정(요약). UI가 "생각 중"을 보여줄 수 있게 별도 이벤트로 분리한다. */
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason };

/**
 * 추론(thinking) 모드.
 *  - "auto": 모델이 알아서 사고 (품질 우선 작업의 기본)
 *  - "off":  사고 비활성화 (지연/비용 우선 작업)
 * 중요: 최신 Claude 모델은 thinking이 기본 ON이고 maxTokens가 '사고 + 응답'을 함께 제한한다.
 * 따라서 짧은 maxTokens + thinking 조합은 가시 응답이 0인 빈 응답을 만든다 —
 * 라우터가 이 조합을 방지한다(router.ts의 THINKING_HEADROOM 참조).
 */
export type ReasoningMode = "auto" | "off";

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningMode;
  abortSignal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}

export interface ModelInfo {
  provider: ProviderId;
  /** 프로바이더 네이티브 모델 id */
  id: string;
  contextWindow: number;
  maxOutput: number;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** 3 = frontier, 2 = mid, 1 = small/fast */
  qualityTier: 1 | 2 | 3;
  tags: TaskClass[];
  /**
   * true면 temperature/top_p/top_k 를 요청에서 제거해야 한다.
   * Anthropic 4.7 이후 모델은 샘플링 파라미터를 400으로 거부한다 — 어댑터가 조용히
   * 전달하면 사용자가 temperature를 지정하는 순간 전체 요청이 실패한다.
   */
  noSampling?: boolean;
  /**
   * true면 이 모델은 thinking이 기본 ON이며, maxTokens가 사고+응답을 함께 제한한다.
   * 라우터가 충분한 출력 여유를 강제하지 않으면 사용자에게 빈 응답이 나간다.
   */
  thinksByDefault?: boolean;
}

// ---------- Agent orchestration events (SSE로 그대로 직렬화) ----------

export type AgentEvent =
  | StreamEvent
  | { type: "strategy"; mode: ChatMode; path: "fast" | "thorough" | "calculator"; reason: string }
  | { type: "context_trimmed"; sections: { section: string; count: number }[] }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_result"; id: string; ok: boolean; summary?: string }
  | { type: "commit"; sha: string; message: string }
  /**
   * 모델은 끝났다고 했는데 완료 판정이 미완이라 루프를 이어 간다.
   * 조용히 재시도하면 사용자는 왜 응답이 길어지는지 알 수 없고, 로그에도 남지 않는다.
   */
  | { type: "incomplete"; reason: string; attempt: number }
  | { type: "error"; code: string; message: string };

// ---------- Memory ----------

export type MemoryKind = "fact" | "preference" | "decision" | "summary";

export interface MemoryScope {
  orgId: string;
  userId?: string;
  projectId?: string;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  score?: number;
}

// ---------- RAG ----------

export interface CodeChunkHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  content: string;
  score: number;
}

// ---------- Auth context ----------

export interface AuthContext {
  orgId: string;
  userId?: string;
  role: "owner" | "admin" | "member" | "viewer";
  scopes: string[];
  /** local = 루프백 무인증 모드(LOCAL_NO_AUTH). 개발/단독 사용 전용. */
  via: "jwt" | "api_key" | "session" | "local";
}
