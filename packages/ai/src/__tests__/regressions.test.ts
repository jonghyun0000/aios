/**
 * 실기동 검증(Phase 1~5)에서 발견한 프로덕션 결함들의 회귀 테스트.
 * 각 테스트는 "이 버그가 다시 들어오면 즉시 빨간불이 켜지는가"만 본다.
 */
import { describe, expect, it } from "vitest";
import { estimateTokens } from "@aios/shared";
import type { CompletionRequest, ModelInfo, StreamEvent } from "@aios/shared";
import { AiRouter } from "../router.js";
import type { ProviderAdapter } from "../adapter.js";

const thinkingModel: ModelInfo = {
  provider: "anthropic", id: "thinker", contextWindow: 1_000_000, maxOutput: 128_000,
  inputCostPerMTok: 5, outputCostPerMTok: 25, supportsTools: true, supportsVision: true,
  qualityTier: 3, tags: ["code", "reasoning"], noSampling: true, thinksByDefault: true,
};

/** 마지막으로 받은 요청을 기록하는 스파이 어댑터 */
function spyAdapter(): ProviderAdapter & { last?: CompletionRequest } {
  const spy: ProviderAdapter & { last?: CompletionRequest } = {
    id: "anthropic",
    async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
      spy.last = req;
      yield { type: "text_delta", text: "ok" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  return spy;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("Phase 1 회귀: 토큰 추정은 보수적(과대)이어야 한다", () => {
  it("영문 산문을 과소 계산하지 않는다", () => {
    // 실측(Anthropic API): 영문 45,000자 → 72,033 토큰 ≈ 1.6 토큰/문자 밀도.
    // chars/4 휴리스틱이었다면 11,250으로 37% 과소 계산되어 컨텍스트를 넘겼다.
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(1000);
    const est = estimateTokens(text);
    const actualRatioLowerBound = text.length / 3.0; // 실측 밀도보다 여유 있게 잡은 하한
    expect(est).toBeGreaterThan(actualRatioLowerBound);
  });

  it("CJK를 문자당 1토큰 이상으로 센다", () => {
    expect(estimateTokens("안녕하세요")).toBeGreaterThanOrEqual(5);
  });
});

describe("Phase 3 회귀: 사고형 모델의 빈 응답 방지", () => {
  it("thinksByDefault 모델에는 출력 여유를 강제한다", async () => {
    // 버그: maxTokens=400 + thinking on → 400 토큰이 전부 사고에 소진되어 가시 응답 0.
    const spy = spyAdapter();
    const router = new AiRouter({ anthropic: spy }, { catalog: [thinkingModel] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 400 }, { taskClass: "code" }));
    expect(spy.last?.maxTokens).toBeGreaterThanOrEqual(4096);
  });

  it("모델의 출력 상한을 넘겨 올리지 않는다", async () => {
    const spy = spyAdapter();
    const small: ModelInfo = { ...thinkingModel, maxOutput: 2048 };
    const router = new AiRouter({ anthropic: spy }, { catalog: [small] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 }, { taskClass: "code" }));
    expect(spy.last?.maxTokens).toBe(2048);
  });

  it("호출자가 이미 큰 예산을 줬으면 그대로 둔다", async () => {
    const spy = spyAdapter();
    const router = new AiRouter({ anthropic: spy }, { catalog: [thinkingModel] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 60_000 }, { taskClass: "code" }));
    expect(spy.last?.maxTokens).toBe(60_000);
  });

  it("저가 작업에서는 사고를 끈다 (비용·지연 절감)", async () => {
    const spy = spyAdapter();
    const router = new AiRouter({ anthropic: spy }, { catalog: [thinkingModel] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 200 }, { taskClass: "summarize" }));
    expect(spy.last?.reasoning).toBe("off");
    // 사고를 껐으므로 예산을 부풀리지 않아야 한다
    expect(spy.last?.maxTokens).toBe(200);
  });

  it("호출자의 명시적 reasoning 설정을 라우터가 덮어쓰지 않는다", async () => {
    const spy = spyAdapter();
    const router = new AiRouter({ anthropic: spy }, { catalog: [thinkingModel] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], reasoning: "auto" }, { taskClass: "cheap" }));
    expect(spy.last?.reasoning).toBe("auto");
  });
});

describe("Phase 3 회귀: 샘플링 파라미터 제약", () => {
  it("noSampling 모델에는 temperature를 전달하지 않는다", async () => {
    // Anthropic 4.7+ 는 temperature를 400으로 거부한다.
    const spy = spyAdapter();
    const router = new AiRouter({ anthropic: spy }, { catalog: [thinkingModel] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], temperature: 0.7 }, { taskClass: "code" }));
    expect(spy.last?.temperature).toBeUndefined();
  });

  it("허용하는 모델에는 그대로 전달한다", async () => {
    const spy = spyAdapter();
    const permissive: ModelInfo = { ...thinkingModel, noSampling: false, thinksByDefault: false };
    const router = new AiRouter({ anthropic: spy }, { catalog: [permissive] });
    await drain(router.stream({ messages: [{ role: "user", content: "hi" }], temperature: 0.7 }, { taskClass: "code" }));
    expect(spy.last?.temperature).toBe(0.7);
  });
});
