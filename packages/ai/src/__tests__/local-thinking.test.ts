import { describe, it, expect } from "vitest";
import { localModels } from "../catalog.js";

/**
 * 사고 모델 표시가 빠지면 라우터가 THINKING_HEADROOM 을 주지 않아
 * 가시 응답이 0자가 된다. 조용히 빈 답이 나가므로 테스트로 고정한다.
 */
describe("localModels — 사고 모델 판별", () => {
  const of = (id: string) => localModels([id], 32768)[0]!;

  it("qwen3 계열은 사고 모델", () => {
    expect(of("qwen3:8b").thinksByDefault).toBe(true);
    expect(of("qwen3:14b-instruct").thinksByDefault).toBe(true);
  });

  it("deepseek-r1 · qwq 도 사고 모델", () => {
    expect(of("deepseek-r1:7b").thinksByDefault).toBe(true);
    expect(of("qwq:32b").thinksByDefault).toBe(true);
  });

  it("qwen2.5 는 사고 모델이 아니다 — 접두사만 겹친다고 잡히면 안 된다", () => {
    expect(of("qwen2.5:7b-instruct").thinksByDefault).toBe(false);
  });

  it("llama3.1 · exaone 은 사고 모델이 아니다", () => {
    expect(of("llama3.1:8b").thinksByDefault).toBe(false);
    expect(of("exaone3.5:7.8b").thinksByDefault).toBe(false);
  });

  it("비용은 0이고 품질 등급은 최하로 둔다", () => {
    const m = of("qwen3:8b");
    expect(m.inputCostPerMTok).toBe(0);
    expect(m.outputCostPerMTok).toBe(0);
    expect(m.qualityTier).toBe(1);
    expect(m.supportsTools).toBe(true);
  });
});
