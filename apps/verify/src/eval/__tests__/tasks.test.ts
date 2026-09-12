import { describe, it, expect } from "vitest";
import { TASKS, type TextTask, type ToolTask } from "../tasks.js";
import type { ToolCall } from "@aios/shared";

/**
 * 채점기 검증.
 *
 * **재는 도구가 틀리면 모든 결론이 틀린다.** 이 저장소에서 실제로 그랬다 —
 * 모델 벤치마크가 사고 토큰을 예산에 포함하지 않아 qwen3 를 굶겨 놓고
 * "한국어 0%" 라고 기록했다. 모델이 아니라 계측기의 결함이었다.
 *
 * 그래서 각 채점기에 **정답이면 통과하고 오답이면 실패하는지**를 고정한다.
 * 특히 "정답인데 실패시키는" 쪽이 위험하다 — 멀쩡한 모델을 나쁘다고 판정한다.
 */

const text = (id: string) => TASKS.find((t) => t.id === id) as TextTask;
const tool = (id: string) => TASKS.find((t) => t.id === id) as ToolTask;
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: "c1", name, arguments: args });

describe("과제 정의 자체", () => {
  it("id 가 중복되지 않는다 — 중복되면 결과가 섞인다", () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("모든 범주가 최소 2과제를 갖는다 — 1과제면 한 번의 우연이 범주 점수를 결정한다", () => {
    const byCat = new Map<string, number>();
    for (const t of TASKS) byCat.set(t.category, (byCat.get(t.category) ?? 0) + 1);
    for (const [cat, n] of byCat) expect(n, `범주 ${cat}`).toBeGreaterThanOrEqual(2);
  });
});

describe("도구 채점기", () => {
  it("도구를 부르면 통과, 설명만 하면 실패 — 실제 사고의 형태다", () => {
    const t = tool("tool.calls-instead-of-explaining");
    expect(t.check([call("write_file", { path: "src/a.ts", content: "x" })], "")).toBe(true);
    expect(t.check([], "I will fix it by changing a - b to a + b.")).toBe(false);
  });

  it("인자가 맞아야 통과한다", () => {
    const t = tool("tool.correct-arguments");
    expect(t.check([call("write_file", { path: "config.json", content: '{"debug":true}' })], "")).toBe(true);
    expect(t.check([call("write_file", { path: "config.json", content: '{"debug":false}' })], "")).toBe(false);
    expect(t.check([call("write_file", { path: "other.txt", content: '{"debug":true}' })], "")).toBe(false);
  });

  it("부르지 말라면 안 불러야 통과한다 — 남용도 결함이다", () => {
    const t = tool("tool.no-spurious-call");
    expect(t.check([], "It writes content to a file in the project.")).toBe(true);
    expect(t.check([call("write_file", {})], "It writes content to a file.")).toBe(false);
  });
});

describe("형식 채점기", () => {
  it("JSON 만 요구했을 때 코드펜스는 허용하되 산문은 거른다", () => {
    const t = text("format.json-only");
    expect(t.check('{"ok":true,"count":3}')).toBe(true);
    expect(t.check('```json\n{"ok":true,"count":3}\n```')).toBe(true); // 펜스는 흔하고 파싱 가능하다
    expect(t.check('Here you go: {"ok":true,"count":3}')).toBe(false);
    expect(t.check('{"ok":false,"count":3}')).toBe(false);
  });

  it("정확히 세 줄", () => {
    const t = text("format.exact-line-count");
    expect(t.check("red\nblue\nyellow")).toBe(true);
    expect(t.check("1. red\n2. blue\n3. yellow")).toBe(false);
    expect(t.check("red\nblue")).toBe(false);
  });

  it("군더더기 없는 한 단어", () => {
    const t = text("format.no-preamble");
    expect(t.check("DONE")).toBe(true);
    expect(t.check("  done \n")).toBe(true);
    expect(t.check("Sure! DONE")).toBe(false);
  });
});

describe("한국어 채점기", () => {
  it("한자·가나가 섞이면 실패한다", () => {
    const t = text("korean.pure-script");
    expect(t.check("인덱스는 검색을 빠르게 하는 자료구조입니다. 조회 성능을 크게 높입니다.")).toBe(true);
    expect(t.check("인덱스는 索引이며 검색을 빠르게 합니다. 조회 성능을 높입니다.")).toBe(false);
  });
  it("영어로만 답하면 실패한다", () => {
    const t = text("korean.answers-in-korean");
    expect(t.check("정답은 4입니다.")).toBe(true);
    expect(t.check("The answer is 4.")).toBe(false);
  });
});

describe("코드 채점기 (실행 기반)", () => {
  it("무한 루프는 시간 제한으로 막는다 — 채점기가 멈추면 검증 전체가 멈춘다", () => {
    const t = text("code.even-sum");
    expect(t.check("function sumEven(xs){ while(true){} }")).toBe(false);
  });
  it("바깥에 손댈 수 없다 — require/process 가 없다", () => {
    const t = text("code.even-sum");
    expect(t.check("function sumEven(xs){ return require('fs') }")).toBe(false);
  });
  it("삼항 연산자를 쓴 정답을 떨어뜨리지 않는다", () => {
    // 실제로 이걸 놓쳐 정답을 0/3 으로 판정했다. 정규식이 `: sum` 을 타입으로 착각해 지웠다.
    const t = text("code.even-sum");
    expect(t.check("function sumEven(xs: number[]): number { return xs.reduce((sum, x) => x % 2 === 0 ? sum + x : sum, 0); }")).toBe(true);
  });
  it("타입이 붙은 화살표 함수·제네릭도 처리한다", () => {
    const t = text("code.even-sum");
    expect(t.check("const sumEven = (xs: Array<number>): number => xs.filter((x: number) => x % 2 === 0).reduce((a: number, b: number) => a + b, 0);")).toBe(true);
  });
  it("경계값도 만족해야 통과한다", () => {
    const t = text("code.even-sum");
    // 빈 배열에서 틀리는 구현은 떨어뜨린다.
    expect(t.check("function sumEven(xs){ return xs.filter(x=>x%2===0).reduce((a,b)=>a+b) }")).toBe(false);
    expect(t.check("function sumEven(xs){ return xs.filter(x=>x%2===0).reduce((a,b)=>a+b,0) }")).toBe(true);
  });

  it("세금을 두 번 더한 오답을 잡는다 — 실제로 나온 실패다", () => {
    const t = text("code.tax-calculation");
    expect(t.check("function invoiceTotal(subtotal: number, taxRate: number): number {\n  return subtotal * (1 + taxRate / 100);\n}")).toBe(true);
    expect(t.check("function invoiceTotal(subtotal: number, taxRate: number): number {\n  return subtotal + subtotal * (1 + taxRate / 100);\n}")).toBe(false);
  });
  it("정답의 다른 표현도 받아들인다 — 형태를 강요하면 멀쩡한 답을 떨어뜨린다", () => {
    const t = text("code.tax-calculation");
    expect(t.check("function invoiceTotal(subtotal: number, taxRate: number): number {\n  return subtotal + subtotal * taxRate / 100;\n}")).toBe(true);
  });
});

describe("정밀도 채점기", () => {
  it("모르는 것을 지어내면 실패한다", () => {
    const t = text("precision.admits-unknown");
    expect(t.check("UNKNOWN")).toBe(true);
    expect(t.check("The population is 2,480,000.")).toBe(false);
  });
  it("한국어 국가명도 정답으로 받는다", () => {
    const t = text("precision.negation");
    expect(t.check("Norway")).toBe(true);
    expect(t.check("노르웨이")).toBe(true);
    expect(t.check("France")).toBe(false);
  });
});
