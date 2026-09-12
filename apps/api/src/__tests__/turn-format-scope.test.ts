import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest } from "@aios/shared";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { resolvePreferences } from "../agent/preferences.js";
import type { AppContext } from "../context.js";

const oldQuestion = "이번 답변만 두 항목을 표로 정리해줘.";
const currentRequest = "이제 notes.txt를 일반 문장 두 문단으로 작성해줘. 저장 후 답변은 한 문장으로 해줘.";
const savedHistory: ChatMessage[] = [
  { role: "user", content: "이 대화에서는 답변을 한국어로 해줘." },
  { role: "assistant", content: "알겠습니다." },
  { role: "user", content: oldQuestion },
  { role: "assistant", content: "|항목|내용|\n|---|---|\n|A|첫째|\n|B|둘째|" },
];

describe("현재 턴의 형식 정책을 실제 모델 요청까지 전달", () => {
  it.each([
    { mode: "fast" as const, toolsEnabled: false },
    { mode: "fast" as const, toolsEnabled: true },
    { mode: undefined, toolsEnabled: true },
  ])("mode=$mode tools=$toolsEnabled에서 기록과 현재 원문을 보존하고 형식 범위를 지시한다", async ({ mode, toolsEnabled }) => {
    const requests: Omit<CompletionRequest, "model">[] = [];
    const stream = vi.fn(async function* (request: Omit<CompletionRequest, "model">) {
      // 실행 루프가 나중에 messages 배열을 덧붙이므로 호출 순간을 복사해 검사한다.
      requests.push({ ...request, messages: [...request.messages] });
      yield { type: "text_delta", text: "합성 응답" };
      yield { type: "done", stopReason: "end_turn" };
    });
    const agent = new AgentOrchestrator({
      memory: { record: async () => {}, buildContext: async () => ({ stmSummary: null, history: [], facts: [] }) },
      pool: { query: async () => ({ rows: [] }) }, router: { stream },
      retriever: { format: () => [] }, bus: { publish: async () => {} }, tools: { specs: () => [] },
    } as unknown as AppContext);
    const preferences = resolvePreferences(savedHistory.filter((message) => message.role === "user").map((message) => message.content), currentRequest);
    expect(preferences).toEqual([{ kind: "language", value: "ko" }]);
    for await (const _ of agent.run({ orgId: "fixture-org", sessionId: "fixture-session", content: currentRequest,
      mode, toolsEnabled, useMemory: true, useLongTermMemory: false, useRag: false, savedHistory, conversationPreferences: preferences })) { /* 합성 응답만 소비: DB·모델·파일 접근 없음 */ }
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.messages).toEqual([...savedHistory, { role: "user", content: currentRequest }]);
    expect(request.system).toContain("The current user request defines this turn's task and deliverables.");
    expect(request.system).toContain("Earlier turn-specific output formats do not carry over");
    expect(request.system).toContain("Keep the format of a conversational reply separate from the format of file contents or tool arguments.");
    expect(request.system).toContain("Default response language: Korean (한국어).");
    expect(request.system).not.toContain(oldQuestion);
    if (toolsEnabled) expect(request.system).toContain("Before proposing a file write, check its contents against the current request's structure, fields, and formatting");
  });
});
