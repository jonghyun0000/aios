import type { LineCitationTask } from "./line-citation-tasks.js";

/**
 * 행 번호 인용 채점기 v2 (docs/40 §3.1).
 * v1(line-citation-tasks.ts 안의 citedLines/grade)은 첫 기준 실행의 출력 5개에서
 * "행 번호는 133입니다", "행 번호: 8" 같은 가장 흔한 표현을 읽지 못함이 드러나 폐기했다.
 * 과제·정답·채택 규칙은 바꾸지 않았고, v1 로 채점한 부분 결과는 ABORTED 로 보존했다.
 */
const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
// "진행", "시행", "은행"처럼 앞 글자가 붙은 행/줄과 "행사"는 행 번호 표기가 아니다.
const LINE_WORD = "(?<![가-힣])(?:행(?!사)|줄|라인)";
const PATTERNS: Array<{ re: RegExp; groups: number }> = [
  // 범위("46~47행", "lines 46-47")는 양끝을 모두 인용한 것으로 본다.
  { re: /(\d{1,5})\s*[~–—-]\s*(\d{1,5})\s*(?:번째\s*|번\s*)?(?:행(?!사)|줄|라인)/g, groups: 2 },
  { re: /\blines?\s*(\d{1,5})\s*[~–—-]\s*(\d{1,5})/gi, groups: 2 },
  // "47행", "47번째 줄", "47번 줄", "47줄"
  { re: /(\d{1,5})\s*(?:번째\s*|번\s*)?(?:행(?!사)|줄|라인)/g, groups: 1 },
  // "행 번호는 133", "행 번호: 8", "행: 40", "줄 번호 40", "행 40"
  { re: new RegExp(`${LINE_WORD}\\s*(?:번호)?\\s*(?:는|은|가|이|:|：|=)?\\s*(?:약\\s*)?(\\d{1,5})`, "g"), groups: 1 },
  // "line 164", "line number is 164", "line #164", "on line: 164"
  { re: /\blines?\s*(?:number)?\s*(?:is|was|:|=)?\s*#?\s*(\d{1,5})/gi, groups: 1 },
  { re: /(?:^|[^A-Za-z0-9])L(\d{1,5})\b/g, groups: 1 },
  { re: /(?:^|[\s`>])(\d{1,5})\|/gm, groups: 1 },
];
export function citedLines(text: string): number[] {
  const found = new Set<number>();
  for (const { re, groups } of PATTERNS) for (const match of text.matchAll(re)) for (let g = 1; g <= groups; g++) found.add(Number(match[g]));
  return [...found].sort((a, b) => a - b);
}
export interface Grade { pass: boolean; valueOk: boolean; lines: number[]; lineOk: boolean | null }
/**
 * line 과제: 값이 들어 있고, 인용한 행 번호가 하나 이상이며 전부 정답 행이어야 PASS.
 * value 과제: 값이 들어 있으면 PASS. 행 번호는 보지 않는다. (v1 과 같은 규칙)
 */
export function grade(task: LineCitationTask, text: string): Grade {
  const valueOk = normalize(text).includes(normalize(task.value));
  const lines = citedLines(text);
  if (task.kind === "value") return { pass: valueOk, valueOk, lines, lineOk: null };
  const lineOk = lines.length > 0 && lines.every((n) => n === task.line);
  return { pass: valueOk && lineOk, valueOk, lines, lineOk };
}
