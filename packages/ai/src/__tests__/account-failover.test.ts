/**
 * Sprint 2 회귀: 계정 수준 실패(크레딧 소진·결제)의 폴백.
 *
 * 버그: "Your credit balance is too low"는 HTTP 400으로 온다. 400은 '요청이 잘못됐다'는
 * 뜻이라 non-retryable로 분류됐고, 결과적으로 **다른 프로바이더로 넘어가지 않았다**.
 * 그러나 이건 요청의 문제가 아니라 계정의 문제다 — 같은 요청을 다른 프로바이더로 보내면
 * 성공한다. 검증 중 실제로 크레딧이 소진되며 발견했다.
 */
import { describe, expect, it } from "vitest";
import { ProviderError } from "@aios/shared";
import type { ModelInfo, StreamEvent } from "@aios/shared";
import { AiRouter } from "../router.js";

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const cheap: ModelInfo = {
  provider: "openai", id: "out-of-credit", contextWindow: 100_000, maxOutput: 4096,
  inputCostPerMTok: 0.01, outputCostPerMTok: 0.01, supportsTools: true, supportsVision: false,
  qualityTier: 2, tags: ["cheap"],
};
const backup: ModelInfo = { ...cheap, provider: "anthropic", id: "funded", inputCostPerMTok: 1, outputCostPerMTok: 1 };

describe("계정 문제 분류", () => {
  const accountMessages = [
    'Your credit balance is too low to access the Anthropic API.',
    '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}',
    "Billing not configured for this project",
    "Payment required",
    "Spending limit reached for this organization",
  ];

  for (const msg of accountMessages) {
    it(`400이어도 계정 문제면 retryable: ${msg.slice(0, 40)}`, () => {
      const e = new ProviderError("openai", msg, { status: 400 });
      expect(e.isAccountIssue).toBe(true);
      expect(e.retryable).toBe(true);
    });
  }

  it("진짜 요청 오류는 여전히 non-retryable (다른 프로바이더로 보내도 똑같이 실패한다)", () => {
    const cases = [
      "messages: roles must alternate between user and assistant",
      "max_tokens: must be greater than 0",
      "model: claude-does-not-exist not found",
    ];
    for (const msg of cases) {
      const e = new ProviderError("anthropic", msg, { status: 400 });
      expect(e.isAccountIssue).toBe(false);
      expect(e.retryable).toBe(false);
    }
  });

  it("연결 실패와 계정 문제는 구분된다", () => {
    const conn = new ProviderError("openai", "network failure: EHOSTUNREACH", { status: 0 });
    const acct = new ProviderError("openai", "credit balance is too low", { status: 400 });
    expect(conn.isConnectionFailure).toBe(true);
    expect(conn.isAccountIssue).toBe(false);
    expect(acct.isConnectionFailure).toBe(false);
    expect(acct.isAccountIssue).toBe(true);
  });
});

describe("라우터가 크레딧 소진에서 폴백한다", () => {
  it("크레딧이 떨어진 프로바이더를 건너뛰고 다른 프로바이더로 응답한다", async () => {
    let outOfCreditAttempts = 0;
    const broke = {
      id: "openai" as const,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> {
        outOfCreditAttempts++;
        throw new ProviderError("openai", "Your credit balance is too low to access the API", { status: 400 });
      },
    };
    const funded = {
      id: "anthropic" as const,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "SERVED-BY-BACKUP" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const router = new AiRouter({ openai: broke, anthropic: funded }, { catalog: [cheap, backup] });
    expect(router.rank({ taskClass: "cheap" })[0]!.id).toBe("out-of-credit");

    const events = await drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" }));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");

    expect(text).toBe("SERVED-BY-BACKUP");
    // 계정 문제는 재시도해도 소용없다 — 같은 모델을 두드리지 않고 바로 넘어가야 한다
    expect(outOfCreditAttempts).toBe(1);
  });

  it("모든 프로바이더의 크레딧이 떨어지면 명확한 에러로 끝난다", async () => {
    const broke = (id: "openai" | "anthropic") => ({
      id,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamEvent> {
        throw new ProviderError(id, "Your credit balance is too low", { status: 400 });
      },
    });
    const router = new AiRouter({ openai: broke("openai"), anthropic: broke("anthropic") }, { catalog: [cheap, backup] });
    await expect(drain(router.stream({ messages: [{ role: "user", content: "x" }], maxTokens: 16 }, { taskClass: "cheap" })))
      .rejects.toThrow(/every candidate model failed/);
  });
});
