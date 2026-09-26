import { describe, expect, it } from "vitest";
import { referenceChunks } from "../../../../api/src/workspace.js";
import { LINE_CITATION_TASKS, VALUE_ONLY_TASKS, citedLines, grade } from "../line-citation-tasks.js";

const all = [...LINE_CITATION_TASKS, ...VALUE_ONLY_TASKS];

describe("행 번호 인용 과제 자체의 정합성", () => {
  it("과제 수와 ID 중복", () => {
    expect(LINE_CITATION_TASKS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(all.map((task) => task.id)).size).toBe(all.length);
  });
  it.each(LINE_CITATION_TASKS.map((task) => [task.id, task] as const))("%s: 정답 행에 값이 있다", (_id, task) => {
    const lines = task.files[0]!.content.split(/\r?\n/);
    const target = task.files.find((file) => file.content.split(/\r?\n/)[task.line! - 1]?.includes(task.value));
    expect(target, `${task.line}행에 ${task.value}`).toBeDefined();
    expect(lines.length).toBeGreaterThan(0);
  });
  it.each(all.map((task) => [task.id, task] as const))("%s: 현재 구간 선택기가 값이 든 구간을 전달한다(검색이 아니라 인용을 잰다)", (_id, task) => {
    const selection = referenceChunks(task.files, task.prompt);
    expect(selection.excerpts.some((excerpt) => excerpt.includes(task.value))).toBe(true);
    // 값이 든 구간의 시작 행
    const hit = selection.sources.find((_, i) => selection.excerpts[i]!.includes(task.value))!;
    if (task.line) expect(hit.startLine <= task.line && task.line <= hit.endLine).toBe(true);
  });
  it("정답 행이 파일 첫 블록 밖(시작 행 > 1)인 과제가 절반 이상이다 — 행 번호 오프셋을 실제로 요구한다", () => {
    const offset = LINE_CITATION_TASKS.filter((task) => {
      const s = referenceChunks(task.files, task.prompt);
      return s.sources.find((_, i) => s.excerpts[i]!.includes(task.value))!.startLine > 1;
    });
    expect(offset.length * 2).toBeGreaterThanOrEqual(LINE_CITATION_TASKS.length);
  });
});

describe("채점기", () => {
  it("여러 인용 형식을 읽는다", () => {
    expect(citedLines("47행에 있습니다")).toEqual([47]);
    expect(citedLines("47번째 줄: 결정 사항")).toEqual([47]);
    expect(citedLines("(line 47)")).toEqual([47]);
    expect(citedLines("L47 에 적혀 있다")).toEqual([47]);
    expect(citedLines("`47| - 결정 사항`")).toEqual([47]);
    expect(citedLines("행사 장소는 세종대로 175")).toEqual([]);
    expect(citedLines("4,200만 원, 2026년 12월")).toEqual([]);
    expect(citedLines("46~47행")).toEqual([46, 47]);
    expect(citedLines("lines 46-47")).toEqual([46, 47]);
    expect(citedLines("2026-11-03 출시")).toEqual([]);
  });
  const task = LINE_CITATION_TASKS.find((t) => t.id === "meeting-budget-47")!;
  it("값과 정답 행만 대면 PASS", () => expect(grade(task, "예산 상한은 4,200만 원이며 47행에 있습니다.").pass).toBe(true));
  it("한 줄 어긋나면 FAIL", () => expect(grade(task, "4,200만 원 (46행)").pass).toBe(false));
  it("정답 행과 다른 행을 함께 대면 FAIL", () => expect(grade(task, "4,200만 원, 46~47행").pass).toBe(false));
  it("범위만 대면 FAIL", () => expect(grade(task, "4,200만 원 (1–80행)").pass).toBe(false));
  it("행 번호가 없으면 FAIL", () => expect(grade(task, "4,200만 원입니다.").pass).toBe(false));
  it("값이 틀리면 FAIL", () => expect(grade(task, "3,800만 원, 47행").pass).toBe(false));
  it("값 과제는 행 번호를 보지 않는다", () => {
    const v = VALUE_ONLY_TASKS[0]!;
    expect(grade(v, "26 개월").pass).toBe(true); expect(grade(v, "24개월").pass).toBe(false);
  });
});
