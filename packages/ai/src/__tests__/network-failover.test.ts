/**
 * Sprint 2 회귀: 네트워크 레벨 실패의 폴백.
 *
 * 버그: fetch가 HTTP 응답을 받지 못하고 던지는 경우(DNS 실패, EHOSTUNREACH, TLS, 리셋)는
 * status가 없어 raw TypeError/AggregateError로 올라왔다. 라우터의 isRetryable()이 false를
 * 반환해 **다른 프로바이더로 넘어가지 않았다** — 폴백이 가장 필요한 순간에 폴백이 죽었다.
 * (IPv6 경로가 없는 네트워크에서 EHOSTUNREACH로 검증 실행 전체가 중단되는 것을 실측.)
 */
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "@aios/shared";
import type { ModelInfo, StreamEvent } from "@aios/shared";
import { AnthropicAdapter } from "../providers/anthropic.js";
import { OpenAiAdapter } from "../providers/openai.js";
import { GeminiAdapter } from "../providers/gemini.js";
import { AiRouter } from "../router.js";
import { wrapNetworkError } from "../adapter.js";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

/** Node가 Happy Eyeballs 실패 시 던지는 형태를 재현 */
function hostUnreachable(): AggregateError {
  const e1 = Object.assign(new Error("connect EHOSTUNREACH 2607:6bc0::10:443"), { code: "EHOSTUNREACH" });
  const e2 = Object.assign(new Error("connect ETIMEDOUT 160.79.104.10:443"), { code: "ETIMEDOUT" });
  return new AggregateError([e1, e2], "");
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("wrapNetworkError", () => {
  it("네트워크 실패를 retryable ProviderError로 감싼다", () => {
    try {
      wrapNetworkError("anthropic", hostUnreachable());
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.retryable).toBe(true);
      // 중첩된 AggregateError 안의 errno까지 끌어내 원인을 남긴다
      expect(pe.message).toContain("EHOSTUNREACH");
      expect(pe.message).toContain("ETIMEDOUT");
    }
  });

  it("abort는 감싸지 않는다 (사용자 취소를 다른 프로바이더로 재시도하면 안 된다)", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(() => wrapNetworkError("anthropic", abort)).toThrow(/aborted/);
    try { wrapNetworkError("anthropic", abort); } catch (e) {
      expect(e).not.toBeInstanceOf(ProviderError);
    }
  });

  it("이미 ProviderError면 그대로 통과시킨다 (이중 래핑 금지)", () => {
    const pe = new ProviderError("openai", "rate limited", { status: 429 });
    try { wrapNetworkError("openai", pe); } catch (e) {
      expect(e).toBe(pe);
      expect((e as ProviderError).retryable).toBe(true);
    }
  });
});

describe("어댑터별 네트워크 실패 분류", () => {
  const adapters = [
    ["anthropic", () => new AnthropicAdapter("k")],
    ["openai", () => new OpenAiAdapter("k")],
    ["gemini", () => new GeminiAdapter("k")],
  ] as const;

  for (const [name, make] of adapters) {
    it(`${name}: fetch 예외가 retryable ProviderError가 된다`, async () => {
      globalThis.fetch = (() => Promise.reject(hostUnreachable()));
      const adapter = make();
      let err: unknown;
      try {
        await drain(adapter.stream({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 16 }));
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
      expect((err as ProviderError).provider).toBe(name);
    });
  }
});

describe("라우터가 네트워크 실패에서 폴백한다", () => {
  const modelA: ModelInfo = {
    provider: "openai", id: "unreachable", contextWindow: 100_000, maxOutput: 4096,
    inputCostPerMTok: 0.01, outputCostPerMTok: 0.01, supportsTools: true, supportsVision: false,
    qualityTier: 2, tags: ["cheap"],
  };
  const modelB: ModelInfo = { ...modelA, provider: "anthropic", id: "healthy", inputCostPerMTok: 1, outputCostPerMTok: 1 };

  it("도달 불가 프로바이더를 건너뛰고 정상 프로바이더로 응답한다", async () => {
    const unreachable = {
      id: "openai" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> { wrapNetworkError("openai", hostUnreachable()); },
    };
    const healthy = {
      id: "anthropic" as const,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "RECOVERED" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const router = new AiRouter({ openai: unreachable, anthropic: healthy }, { catalog: [modelA, modelB] });

    // 단가가 낮은 unreachable이 cheap 라우팅에서 먼저 선택되는지 먼저 확인 —
    // 그래야 폴백 경로를 실제로 밟는다
    expect(router.rank({ taskClass: "cheap" })[0]!.id).toBe("unreachable");

    const events = await drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" }));
    const routed = events.filter((e) => e.type === "routed").map((e) => (e as { provider: string }).provider);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    // routed는 모델이 바뀔 때만 나온다 — 같은 모델 재시도는 클라이언트에 재공지하지 않는다
    expect(routed).toEqual(["openai", "anthropic"]);
    expect(text).toBe("RECOVERED");
  });

  it("간헐적 연결 실패는 같은 모델로 재시도해 복구한다 (단일 프로바이더에서 폴백이 무의미한 경우)", async () => {
    let attempts = 0;
    const flaky = {
      id: "anthropic" as const,
      async *stream(): AsyncGenerator<StreamEvent> {
        attempts++;
        if (attempts === 1) wrapNetworkError("anthropic", hostUnreachable());
        yield { type: "text_delta", text: "RECOVERED-SAME-MODEL" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    // 후보가 하나뿐이다 — 다음 모델로 넘어가는 폴백으로는 절대 복구할 수 없는 상황
    const router = new AiRouter({ anthropic: flaky }, { catalog: [modelB] });
    const events = await drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    expect(attempts).toBe(2);
    expect(text).toBe("RECOVERED-SAME-MODEL");
  });

  it("프로바이더가 돌려준 429는 같은 모델로 재시도하지 않고 다음 후보로 넘어간다", async () => {
    let aAttempts = 0;
    const rateLimited = {
      id: "openai" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> {
        aAttempts++;
        throw new ProviderError("openai", "rate limited", { status: 429 });
      },
    };
    const healthy = {
      id: "anthropic" as const,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "OTHER-PROVIDER" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const router = new AiRouter({ openai: rateLimited, anthropic: healthy }, { catalog: [modelA, modelB] });
    const events = await drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    // 429는 그 프로바이더의 용량 문제 — 같은 모델을 두드리면 시간만 버린다
    expect(aAttempts).toBe(1);
    expect(text).toBe("OTHER-PROVIDER");
  });

  it("연결 실패가 계속되면 재시도를 소진하고 다음 후보로 넘어간다", async () => {
    let deadAttempts = 0;
    const dead = {
      id: "openai" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> {
        deadAttempts++;
        wrapNetworkError("openai", hostUnreachable());
      },
    };
    const healthy = {
      id: "anthropic" as const,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "FELL-THROUGH" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const router = new AiRouter({ openai: dead, anthropic: healthy }, { catalog: [modelA, modelB] });
    const events = await drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    expect(deadAttempts).toBe(3); // 최초 1회 + 재시도 2회
    expect(text).toBe("FELL-THROUGH");
  });

  it("모든 프로바이더가 도달 불가면 명확한 에러로 끝난다", async () => {
    const dead = {
      id: "openai" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> { wrapNetworkError("openai", hostUnreachable()); },
    };
    const alsoDead = {
      id: "anthropic" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> { wrapNetworkError("anthropic", hostUnreachable()); },
    };
    const router = new AiRouter({ openai: dead, anthropic: alsoDead }, { catalog: [modelA, modelB] });
    await expect(drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" })))
      .rejects.toThrow(/every candidate model failed/);
  });
});
