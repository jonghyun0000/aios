import type { ModelInfo } from "@aios/shared";

/**
 * 모델 카탈로그 — 라우팅의 정적 사실(비용/컨텍스트/능력).
 * 코드에 두는 이유: 모델 추가는 배포와 함께 리뷰되어야 하는 변경이다(비용 단가가 틀리면 과금 사고).
 * 동적 사실(지연/성공률)은 런타임 HealthTracker가 관리한다 — 정적/동적 분리.
 * 단가는 USD / 1M tokens. 신규 모델 추가 시 이 배열만 수정하면 된다.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  // --- Anthropic ---
  // 주의: 4.7 이후 모델은 temperature/top_p/top_k 를 거부(400)한다 → noSampling 플래그로 표기.
  {
    provider: "anthropic", id: "claude-opus-5", contextWindow: 1_000_000, maxOutput: 128_000,
    inputCostPerMTok: 5, outputCostPerMTok: 25, supportsTools: true, supportsVision: true,
    qualityTier: 3, tags: ["code", "reasoning", "chat"], noSampling: true, thinksByDefault: true,
  },
  {
    provider: "anthropic", id: "claude-sonnet-5", contextWindow: 1_000_000, maxOutput: 128_000,
    inputCostPerMTok: 3, outputCostPerMTok: 15, supportsTools: true, supportsVision: true,
    qualityTier: 3, tags: ["code", "chat", "reasoning"], noSampling: true, thinksByDefault: true,
  },
  {
    provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 200_000, maxOutput: 64_000,
    inputCostPerMTok: 1, outputCostPerMTok: 5, supportsTools: true, supportsVision: true,
    qualityTier: 2, tags: ["cheap", "summarize", "chat"],
  },
  // --- OpenAI ---
  {
    provider: "openai", id: "gpt-5.2", contextWindow: 400_000, maxOutput: 128_000,
    inputCostPerMTok: 1.75, outputCostPerMTok: 14, supportsTools: true, supportsVision: true,
    qualityTier: 3, tags: ["code", "reasoning", "chat", "vision"],
  },
  {
    provider: "openai", id: "gpt-5-mini", contextWindow: 400_000, maxOutput: 128_000,
    inputCostPerMTok: 0.25, outputCostPerMTok: 2, supportsTools: true, supportsVision: true,
    qualityTier: 2, tags: ["cheap", "summarize", "chat"],
  },
  // --- Google ---
  {
    provider: "gemini", id: "gemini-2.5-pro", contextWindow: 1_000_000, maxOutput: 65_000,
    inputCostPerMTok: 1.25, outputCostPerMTok: 10, supportsTools: true, supportsVision: true,
    qualityTier: 3, tags: ["reasoning", "chat", "vision", "code"],
  },
  {
    provider: "gemini", id: "gemini-2.5-flash", contextWindow: 1_000_000, maxOutput: 65_000,
    inputCostPerMTok: 0.3, outputCostPerMTok: 2.5, supportsTools: true, supportsVision: true,
    qualityTier: 2, tags: ["cheap", "summarize", "chat", "vision"],
  },
  // --- xAI ---
  {
    provider: "xai", id: "grok-4", contextWindow: 256_000, maxOutput: 64_000,
    inputCostPerMTok: 3, outputCostPerMTok: 15, supportsTools: true, supportsVision: true,
    qualityTier: 3, tags: ["reasoning", "chat", "code"],
  },
];

/**
 * 로컬 모델을 카탈로그에 등록한다.
 *
 * 다른 프로바이더처럼 상수 배열에 박지 않는 이유: 어떤 모델을 받았는지는 사용자의
 * 머신 상태이지 우리가 아는 사실이 아니다. 코드에 박으면 사용자가 다른 모델을 받는 순간
 * 카탈로그가 거짓말을 한다.
 *
 * 비용을 0으로 두는 것은 정확하다 — 로컬 추론은 과금되지 않는다. 그 결과 라우터의
 * 비용 점수에서 항상 최상위가 되므로, 외부 모델과 함께 설정된 경우 cheap/summarize 작업이
 * 자동으로 로컬로 흐른다. 이것은 의도된 동작이다.
 *
 * qualityTier를 1(최하)로 두는 이유: 7B급 로컬 모델은 프런티어 모델보다 뚜렷이 약하다.
 * 품질 우선 작업에서 외부 모델이 있으면 그쪽이 선택되어야 한다.
 */
/**
 * 모델 id로 사고(thinking) 모델인지 추정한다.
 *
 * 왜 필요한가: 사고 모델은 max_tokens 가 '사고 + 응답'을 함께 제한한다.
 * 표시하지 않으면 라우터의 THINKING_HEADROOM 이 적용되지 않아 **가시 응답이 0자**가 된다.
 * claude-opus-5 에서 겪었던 것과 같은 문제이고, qwen3 도 같다
 * (실측: max_tokens=120 → content 0자 / reasoning 639자 / finish=length).
 *
 * 이름으로 추정하는 이유: 로컬 서버의 모델 목록은 사용자가 정하므로 우리가 알 수 없다.
 * Ollama의 /api/show 로 조회할 수도 있지만, 카탈로그 구성은 부팅 시 동기적으로 일어나
 * 네트워크 왕복을 넣기에 적절하지 않다. 틀리면 예산이 조금 낭비될 뿐 응답은 나온다.
 */
function looksLikeThinkingModel(id: string): boolean {
  return /(^|[/:._-])(qwen3|deepseek-r1|qwq|magistral|reasoning|thinking)/i.test(id);
}

export function localModels(ids: string[], contextWindow: number): ModelInfo[] {
  return ids
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({
      provider: "local" as const,
      id,
      contextWindow,
      // 출력 상한은 컨텍스트의 절반으로 잡는다. 로컬 서버는 초과 요청을 조용히 자르는
      // 경우가 있어 라우터가 먼저 막는 편이 낫다.
      maxOutput: Math.floor(contextWindow / 2),
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      supportsTools: true,
      supportsVision: false,
      qualityTier: 1 as const,
      tags: ["chat", "cheap", "summarize"],
      thinksByDefault: looksLikeThinkingModel(id),
    }));
}

export function findModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function costUsd(m: ModelInfo, inputTokens: number, outputTokens: number): number {
  return (inputTokens * m.inputCostPerMTok + outputTokens * m.outputCostPerMTok) / 1_000_000;
}
