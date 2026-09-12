import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@aios/shared";
import { estimateMessagesTokens, estimateTokens } from "@aios/shared";
import { assemblePrompt, renderTemplate, CHAT_SYSTEM_TEMPLATE, SYSTEM_CORE_TEMPLATE } from "../prompt.js";

describe("assemblePrompt", () => {
  it("never drops the system core or user message", () => {
    const out = assemblePrompt({
      systemCore: "CORE",
      memoryFacts: [],
      ragChunks: [],
      history: [],
      userMessage: "hello",
      budgetTokens: 50,
    });
    expect(out.system).toContain("CORE");
    expect(out.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  it("cuts low-priority items first when over budget and reports drops", () => {
    const bigChunk = "x".repeat(4000); // ~1000 tokens each
    const out = assemblePrompt({
      systemCore: "CORE",
      memoryFacts: ["fact-1", "fact-2"],
      ragChunks: [bigChunk, bigChunk, bigChunk, bigChunk, bigChunk],
      history: [],
      userMessage: "q",
      budgetTokens: 2500,
    });
    const dropped = out.dropped.find((d) => d.section === "rag");
    expect(dropped).toBeDefined();
    expect(dropped!.count).toBeGreaterThan(0);
    // 메모리(우선순위 80)는 RAG(70)보다 먼저 배치되어 살아남는다
    expect(out.system).toContain("fact-1");
  });

  it("keeps the most recent history when trimming", () => {
    // 배열 타입을 명시한다. `as` 단언을 쓰면 lint의 no-unnecessary-type-assertion 이
    // 이를 제거해 타입이 string으로 넓어진다 — 선언이 단언보다 안정적이다.
    const history: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i} ` + "pad".repeat(200),
    }));
    const out = assemblePrompt({
      systemCore: "CORE",
      memoryFacts: [],
      ragChunks: [],
      history,
      userMessage: "q",
      budgetTokens: 2000,
    });
    const contents = out.messages.map((m) => m.content).join("\n");
    expect(contents).toContain("message-19"); // 최신 보존
    expect(contents).not.toContain("message-0 "); // 오래된 것부터 절단
  });
  it("accounts for section headers, separators and user message overhead", () => {
    const out = assemblePrompt({ systemCore: "CORE", memoryFacts: ["fact"], ragChunks: ["data"], stmSummary: "summary", history: [], userMessage: "q", budgetTokens: 70 });
    const actualEstimate = estimateTokens(out.system) + estimateMessagesTokens(out.messages);
    expect(actualEstimate).toBeLessThanOrEqual(Math.floor(70 * .9));
    expect(out.usedTokens).toBeGreaterThanOrEqual(actualEstimate);
  });
  it("reports only the actually included evidence indexes when a large chunk is skipped", () => {
    const out = assemblePrompt({ systemCore: "CORE", memoryFacts: [], ragChunks: ["x".repeat(4000), "SMALL-EVIDENCE"], history: [], userMessage: "q", budgetTokens: 500 });
    expect(out.retainedRagIndexes).toEqual([1]);
    expect(out.system).toContain("SMALL-EVIDENCE"); expect(out.system).not.toContain("x".repeat(4000));
    expect(out.dropped).toContainEqual({ section: "rag", count: 1 });
    expect(out.usedTokens).toBeGreaterThanOrEqual(estimateTokens(out.system) + estimateMessagesTokens(out.messages));
  });
});

describe("현재 요청과 과거 답변 형식의 범위", () => {
  // 실제 다중 턴에서 이전 표 형식이 새 파일 내용으로 이월된 결함의 정책 계약이다.
  // 문구 전달은 보장하지만 모델 준수를 증명하지 않으므로 실제 업무 평가도 별도로 실행한다.
  it.each([CHAT_SYSTEM_TEMPLATE, SYSTEM_CORE_TEMPLATE])("일상 답변과 도구 작업 모두 현재 요청의 형식을 우선한다", (template) => {
    expect(template).toContain("The current user request defines this turn's task and deliverables.");
    expect(template).toContain("Earlier turn-specific output formats do not carry over");
    expect(template).toContain("Only explicitly persistent user preferences continue as defaults");
    expect(template).toContain("Keep the format of a conversational reply separate from the format of file contents or tool arguments.");
  });

  it("도구 프롬프트는 파일 제안 전에 현재 산출물의 구조를 대조하도록 지시한다", () => {
    expect(SYSTEM_CORE_TEMPLATE).toContain("Before proposing a file write, check its contents against the current request's structure, fields, and formatting");
  });
});

describe("SYSTEM_CORE_TEMPLATE — 자기 검증 규칙", () => {
  /**
   * 왜 프롬프트 문구를 테스트하는가: 이 규칙은 실제 결함에서 나왔다.
   * 전체 제품 시나리오에서 에이전트가 코드를 고친 뒤 **테스트를 다시 돌리지 않고**
   * "완료"를 선언했고, 그 수정은 틀려 있었다(invoiceTotal: got 84, want 44).
   * 시스템은 정상 동작했다 — 테스트 러너가 틀린 코드를 잡았다. 빠진 것은
   * "고쳤으면 확인하라"는 지시였다.
   *
   * 프롬프트는 코드처럼 리팩터링되고, 문구 하나가 빠져도 컴파일은 통과한다.
   * 그래서 계약으로 고정한다.
   */
  it("수정 후 검증하라는 지시가 들어 있다", () => {
    expect(SYSTEM_CORE_TEMPLATE).toMatch(/verify the change/i);
    expect(SYSTEM_CORE_TEMPLATE).toMatch(/run its tests|type check/i);
  });

  it("확인 전에는 완료라고 말하지 말라는 지시가 들어 있다", () => {
    // 이게 핵심이다 — 검증하라는 말만으로는 "돌려보고 실패해도 완료 선언"을 막지 못한다.
    expect(SYSTEM_CORE_TEMPLATE).toMatch(/until you have SEEN it pass/);
    expect(SYSTEM_CORE_TEMPLATE).toMatch(/keep working/i);
  });

  it("사용자의 명시적 금지가 검증 규칙보다 우선한다", () => {
    // 이 조항이 없으면 "테스트를 돌리지 마라"는 작업 지시와 정면으로 충돌한다.
    // 실제로 그런 단계가 있고, 규칙이 지시를 이기면 안 된다.
    expect(SYSTEM_CORE_TEMPLATE).toMatch(/explicitly told you not to run something, obey that/);
  });

  it("렌더링 후에도 규칙이 남는다", () => {
    const rendered = renderTemplate(SYSTEM_CORE_TEMPLATE, { projectName: "p", workdir: "/w" });
    expect(rendered).toMatch(/until you have SEEN it pass/);
    expect(rendered).not.toMatch(/\{\{/); // 치환되지 않은 자리가 남으면 안 된다
  });

  it("현재 승인·복구 흐름을 Git 커밋으로 단정하지 않는다", () => {
    expect(SYSTEM_CORE_TEMPLATE).not.toContain("Every file mutation will be checkpointed as a git commit.");
    expect(SYSTEM_CORE_TEMPLATE).toContain("Do not claim a checkpoint or git commit unless a tool result confirms it.");
  });
});
