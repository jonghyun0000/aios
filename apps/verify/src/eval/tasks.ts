import type { ToolCall, ToolSpec } from "@aios/shared";
import { satisfies } from "./sandbox.js";

/**
 * eval 과제 세트.
 *
 * **고르는 기준: 이 제품이 실제로 의존하는 능력, 그리고 실제로 깨졌던 능력.**
 * 벤치마크 점수를 올리는 것이 목적이 아니라, 모델·프롬프트를 바꿨을 때
 * **제품이 나빠졌는지**를 아는 것이 목적이다.
 *
 * 그래서 아래 범주는 전부 이 저장소에서 실제로 사고가 났던 곳이다:
 *  - tool      : 에이전트가 도구를 부르지 않고 산문으로 설명만 해 수리가 실패했다
 *  - format    : 출력 형식을 어겨 파싱이 깨졌다(사실 추출 JSON)
 *  - korean    : qwen2.5 가 한국어 응답에 중국어를 섞었다
 *  - code      : 수리한 코드가 틀렸다(invoiceTotal: got 84, want 44)
 *  - precision : 부정·경계 조건을 놓쳤다
 *
 * **채점은 전부 결정론적이다.** LLM-as-judge 를 쓰면 채점 자체가 비결정이 되어
 * 회귀 감지가 불가능해진다 — 재는 도구가 흔들리면 아무것도 잴 수 없다.
 */

export type Category = "tool" | "format" | "korean" | "code" | "precision";

export interface TextTask {
  kind: "text";
  id: string;
  category: Category;
  prompt: string;
  maxTokens?: number;
  check: (out: string) => boolean;
}

export interface ToolTask {
  kind: "tool";
  id: string;
  category: Category;
  prompt: string;
  tools: ToolSpec[];
  maxTokens?: number;
  check: (calls: ToolCall[], out: string) => boolean;
}

export type EvalTask = TextTask | ToolTask;

/** 한자·가나가 섞였는가. 한국어 응답에 섞이면 그 자체로 결함이다. */
const hasForeignScript = (s: string) => /[一-鿿぀-ヿ]/.test(s);

const writeFileSpec: ToolSpec = {
  name: "write_file",
  description: "Write content to a file in the project.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};
const runTestsSpec: ToolSpec = {
  name: "run_tests",
  description: "Run the project's test suite.",
  parameters: { type: "object", properties: {} },
};

export const TASKS: EvalTask[] = [
  // ---------- tool: 설명이 아니라 실행 ----------
  {
    kind: "tool", id: "tool.calls-instead-of-explaining", category: "tool",
    prompt: "The file src/a.ts has a bug: `add` returns a - b. Fix it. Use write_file.",
    tools: [writeFileSpec, runTestsSpec],
    // 실제 사고의 형태: 고치겠다고 설명만 하고 도구를 부르지 않았다.
    check: (calls) => calls.some((c) => c.name === "write_file"),
  },
  {
    kind: "tool", id: "tool.correct-arguments", category: "tool",
    prompt: "Create a file named config.json containing exactly {\"debug\":true}. Use write_file.",
    tools: [writeFileSpec],
    check: (calls) => {
      const c = calls.find((x) => x.name === "write_file");
      if (!c) return false;
      const a = c.arguments as { path?: string; content?: string };
      return /config\.json$/.test(a.path ?? "") && /"debug"\s*:\s*true/.test(a.content ?? "");
    },
  },
  {
    kind: "tool", id: "tool.no-spurious-call", category: "tool",
    prompt: "What does the write_file tool do? Answer in one sentence. Do not call any tool.",
    tools: [writeFileSpec, runTestsSpec],
    // 반대 방향도 재야 한다 — 아무 때나 도구를 부르는 것도 결함이다.
    check: (calls, out) => calls.length === 0 && out.trim().length > 10,
  },

  // ---------- format: 파싱 가능한 출력 ----------
  {
    kind: "text", id: "format.json-only", category: "format",
    prompt: 'Reply with only this JSON, no prose, no code fences: {"ok":true,"count":3}',
    check: (o) => {
      try {
        const j = JSON.parse(o.trim().replace(/^```json?\s*|```\s*$/g, ""));
        return j.ok === true && j.count === 3;
      } catch { return false; }
    },
  },
  {
    kind: "text", id: "format.exact-line-count", category: "format",
    prompt: "List exactly three primary colors, one per line, no numbering, no extra text.",
    check: (o) => {
      const lines = o.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.length === 3 && lines.every((l) => !/^[\d.\-*]/.test(l) && l.length < 25);
    },
  },
  {
    kind: "text", id: "format.no-preamble", category: "format",
    prompt: "Reply with only the word DONE. Nothing else.",
    check: (o) => o.trim().toUpperCase() === "DONE",
  },

  // ---------- korean: 한국어 순도 ----------
  {
    kind: "text", id: "korean.pure-script", category: "korean",
    prompt: "데이터베이스 인덱스가 무엇인지 두 문장으로 설명하라. 한국어로만 답하라.",
    maxTokens: 400,
    // qwen2.5 는 여기서 한자를 섞었다. 섞이면 사용자에게 그대로 보인다.
    check: (o) => o.trim().length > 20 && !hasForeignScript(o),
  },
  {
    kind: "text", id: "korean.answers-in-korean", category: "korean",
    prompt: "What is 2+2? 한국어로 한 문장으로 답하라.",
    check: (o) => /[가-힣]/.test(o) && /4|넷|사/.test(o) && !hasForeignScript(o),
  },

  // ---------- code: 실행 가능한 정답 ----------
  {
    kind: "text", id: "code.tax-calculation", category: "code",
    // 실제 실패를 그대로 옮겼다 — 세금을 두 번 더해 84/80.04 가 나왔다.
    prompt:
      "Write a TypeScript function `invoiceTotal(subtotal: number, taxRate: number): number` " +
      "that returns the subtotal plus tax, where taxRate is a percentage. " +
      "invoiceTotal(40, 10) must return 44. Reply with only the code, no fences, no explanation.",
    maxTokens: 400,
    // 형태를 추측하지 않고 **실행해서** 판정한다. 경계값도 함께 본다.
    check: (o) => satisfies(o, "invoiceTotal", [
      { args: [40, 10], expect: 44 },
      { args: [0, 10], expect: 0 },
      { args: [100, 0], expect: 100 },
    ]),
  },
  {
    kind: "text", id: "code.even-sum", category: "code",
    prompt:
      "Write a TypeScript function `sumEven(xs: number[]): number` returning the sum of even numbers. " +
      "Reply with only the code, no fences, no explanation.",
    check: (o) => satisfies(o, "sumEven", [
      { args: [[1, 2, 3, 4]], expect: 6 },
      { args: [[]], expect: 0 },
      { args: [[1, 3, 5]], expect: 0 },
    ]),
  },

  // ---------- precision: 부정·경계 ----------
  {
    kind: "text", id: "precision.negation", category: "precision",
    prompt: "Name a European country that does NOT use the euro. Reply with only the country name.",
    check: (o) =>
      /norway|sweden|denmark|poland|switzerland|united kingdom|uk|czech|hungary|romania|bulgaria|iceland|스웨덴|노르웨이|덴마크|폴란드|스위스|영국/i
        .test(o.trim()),
  },
  {
    kind: "text", id: "precision.arithmetic", category: "precision",
    prompt: "What is 17 * 23 + 41? Reply with only the number.",
    check: (o) => /\b432\b/.test(o),
  },
  {
    kind: "text", id: "precision.admits-unknown", category: "precision",
    // 모르는 것을 지어내지 않는가. RAG 없이 답을 만들어 내면 제품이 거짓을 말한다.
    prompt:
      "What is the exact population of the fictional city of Zyrthandia as of 2024? " +
      "If you do not know, reply with only: UNKNOWN",
    check: (o) => /unknown/i.test(o.trim()) && !/\d{4,}/.test(o),
  },
];

export const CATEGORIES: Category[] = ["tool", "format", "korean", "code", "precision"];
