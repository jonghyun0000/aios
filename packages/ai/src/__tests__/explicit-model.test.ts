import { describe, expect, it } from "vitest";
import type { CompletionRequest, StreamEvent } from "@aios/shared";
import { AiosError } from "@aios/shared";
import { AiRouter } from "../router.js";
import { MODEL_CATALOG, localModels } from "../catalog.js";
import type { ProviderAdapter } from "../adapter.js";

/** docs/41: 명시 선택은 이 라우터에 실제로 설정된 모델만 대상으로 한다. */
function adapter(id: "local" | "openai", seen: string[]): ProviderAdapter {
  return { id, async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> { seen.push(req.model); yield { type: "text_delta", text: "ok" }; yield { type: "done", stopReason: "end_turn" }; } };
}
const collect = async (it: AsyncGenerator<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out; };

describe("명시적 모델 선택", () => {
  it("설정으로 추가한 로컬 모델을 지정하면 그 모델로만 호출한다", async () => {
    const seen: string[] = [];
    const router = new AiRouter({ local: adapter("local", seen) }, { catalog: [...MODEL_CATALOG, ...localModels(["qwen3:8b", "exaone3.5:7.8b"], 32768)] });
    expect(router.rank({ model: "qwen3:8b" }).map((m) => m.id)).toEqual(["qwen3:8b"]);
    const events = await collect(router.stream({ messages: [{ role: "user", content: "hi" }] }, { model: "exaone3.5:7.8b" }));
    expect(seen).toEqual(["exaone3.5:7.8b"]);
    expect(events.find((e) => e.type === "routed")).toMatchObject({ model: "exaone3.5:7.8b" });
  });

  it("설정되지 않은 모델은 사용 가능한 이름과 함께 400", () => {
    const router = new AiRouter({ local: adapter("local", []) }, { catalog: localModels(["qwen3:8b"], 32768) });
    let error: unknown;
    try { router.rank({ model: "llama3.1:8b" }); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(AiosError);
    expect(error).toMatchObject({ code: "unknown_model", status: 400, retryable: false });
    expect((error as Error).message).toContain("available: qwen3:8b");
  });

  it("코드 상수 카탈로그에 있어도 어댑터(키)가 없는 프로바이더의 모델은 거부한다", () => {
    const cloud = MODEL_CATALOG.find((m) => m.provider === "anthropic")!;
    const router = new AiRouter({ local: adapter("local", []) }, { catalog: [...MODEL_CATALOG, ...localModels(["qwen3:8b"], 32768)] });
    expect(() => router.rank({ model: cloud.id })).toThrow(/unavailable/);
  });

  it("사용자 지정 카탈로그 밖의 모델은 상수 카탈로그에 있고 어댑터가 있어도 거부한다", () => {
    const openai = MODEL_CATALOG.find((m) => m.provider === "openai")!;
    const router = new AiRouter({ local: adapter("local", []), openai: adapter("openai", []) }, { catalog: localModels(["qwen3:8b"], 32768) });
    expect(() => router.rank({ model: openai.id })).toThrow(/unavailable\. available: qwen3:8b/);
  });

  it("명시 선택한 모델이 실패해도 다른 모델로 대체하지 않는다", async () => {
    const seen: string[] = [];
    const failing: ProviderAdapter = { id: "local", async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> { seen.push(req.model); if (req.model) throw Object.assign(new Error("down"), { retryable: true }); yield { type: "done", stopReason: "end_turn" }; } };
    const router = new AiRouter({ local: failing }, { catalog: localModels(["qwen3:8b", "exaone3.5:7.8b"], 32768) });
    await expect(collect(router.stream({ messages: [{ role: "user", content: "hi" }] }, { model: "qwen3:8b" }))).rejects.toThrow();
    expect(new Set(seen)).toEqual(new Set(["qwen3:8b"]));
  });
});
