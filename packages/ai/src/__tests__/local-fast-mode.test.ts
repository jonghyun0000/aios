import { describe, expect, it } from "vitest";
import type { CompletionRequest } from "@aios/shared";
import { LocalAdapter } from "../providers/local.js";
import { OpenAiAdapter } from "../providers/openai.js";

class InspectLocal extends LocalAdapter {
  wire(req: CompletionRequest) { return this.toWire(req); }
}
class InspectCloud extends OpenAiAdapter {
  wire(req: CompletionRequest) { return this.toWire(req); }
}
const request: CompletionRequest = { model: "qwen3:8b", messages: [{ role: "user", content: "안녕" }], reasoning: "off" };

describe("로컬 빠른 응답 직렬화", () => {
  const local = new InspectLocal("http://127.0.0.1:11434/v1");
  it("off가 실제 Ollama 전송 필드에 들어간다", () => {
    expect(local.wire(request).reasoning_effort).toBe("none");
    expect(local.wire({ ...request, reasoning: "auto" })).not.toHaveProperty("reasoning_effort");
    expect(local.wire({ ...request, reasoning: undefined })).not.toHaveProperty("reasoning_effort");
  });
  it("클라우드 어댑터의 요청은 바꾸지 않는다", () => {
    expect(new InspectCloud("test").wire(request)).not.toHaveProperty("reasoning_effort");
  });
  it("회귀 결함 주입: reasoning 필드가 유실되면 검사가 실패한다", () => {
    const broken = local.wire(request);
    delete broken.reasoning_effort;
    expect(() => expect(broken.reasoning_effort).toBe("none")).toThrow();
  });
});
