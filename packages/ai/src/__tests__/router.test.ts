import { describe, expect, it } from "vitest";
import type { CompletionRequest, ModelInfo, StreamEvent } from "@aios/shared";
import { ProviderError } from "@aios/shared";
import { AiRouter } from "../router.js";
import type { ProviderAdapter } from "../adapter.js";

const cheapModel: ModelInfo = {
  provider: "openai", id: "mini", contextWindow: 100_000, maxOutput: 8000,
  inputCostPerMTok: 0.2, outputCostPerMTok: 1, supportsTools: true, supportsVision: false,
  qualityTier: 2, tags: ["cheap", "summarize"],
};
const frontierModel: ModelInfo = {
  provider: "anthropic", id: "frontier", contextWindow: 200_000, maxOutput: 8000,
  inputCostPerMTok: 3, outputCostPerMTok: 15, supportsTools: true, supportsVision: true,
  qualityTier: 3, tags: ["code", "reasoning"],
};

function fakeAdapter(id: "openai" | "anthropic", events: StreamEvent[] | Error): ProviderAdapter {
  return {
    id,

    async *stream(_req: CompletionRequest) {
      if (events instanceof Error) throw events;
      for (const e of events) yield e;
    },
  };
}

const okEvents: StreamEvent[] = [
  { type: "text_delta", text: "hi" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
  { type: "done", stopReason: "end_turn" },
];

describe("AiRouter", () => {
  it("routes code tasks to the frontier model and cheap tasks to the cheap model", () => {
    const router = new AiRouter(
      { openai: fakeAdapter("openai", okEvents), anthropic: fakeAdapter("anthropic", okEvents) },
      { catalog: [cheapModel, frontierModel] },
    );
    expect(router.rank({ taskClass: "code" })[0]!.id).toBe("frontier");
    expect(router.rank({ taskClass: "summarize" })[0]!.id).toBe("mini");
  });

  it("falls back to the next candidate on a retryable pre-token failure", async () => {
    const router = new AiRouter(
      {
        anthropic: fakeAdapter("anthropic", new ProviderError("anthropic", "overloaded", { status: 529 })),
        openai: fakeAdapter("openai", okEvents),
      },
      { catalog: [frontierModel, cheapModel] },
    );
    const out: StreamEvent[] = [];
    for await (const ev of router.stream({ messages: [{ role: "user", content: "x" }] }, { taskClass: "code" })) {
      out.push(ev);
    }
    // 폴백 후 openai에서 텍스트가 나와야 한다
    expect(out.some((e) => e.type === "text_delta")).toBe(true);
    const routed = out.filter((e) => e.type === "routed");
    expect(routed.map((r) => (r as { provider: string }).provider)).toEqual(["anthropic", "openai"]);
  });

  it("does NOT fall back on a non-retryable error", async () => {
    const router = new AiRouter(
      {
        anthropic: fakeAdapter("anthropic", new ProviderError("anthropic", "bad request", { status: 400 })),
        openai: fakeAdapter("openai", okEvents),
      },
      { catalog: [frontierModel, cheapModel] },
    );
    const run = async () => {
      for await (const _ of router.stream({ messages: [{ role: "user", content: "x" }] }, { taskClass: "code" })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow(/bad request/);
  });

  it("opens the circuit after 5 failures and excludes the model from candidates", async () => {
    const failing = fakeAdapter("anthropic", new ProviderError("anthropic", "boom", { status: 500 }));
    const router = new AiRouter(
      { anthropic: failing, openai: fakeAdapter("openai", okEvents) },
      { catalog: [frontierModel, cheapModel] },
    );
    for (let i = 0; i < 5; i++) {
      for await (const _ of router.stream({ messages: [{ role: "user", content: "x" }] }, { taskClass: "code" })) {
        /* drain — falls back to openai each time */
      }
    }
    expect(router.rank({ taskClass: "code" }).map((m) => m.id)).not.toContain("frontier");
  });
});
