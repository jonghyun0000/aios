import { expect, it } from "vitest";
import { isKoreanGreeting } from "../eval/chat-checks.js";
it("동일 의미의 정상 인사를 잘못 실패시키지 않는다", () => {
  for (const greeting of ["안녕하세요, 처음 뵙겠습니다.", "안녕하세요, 처음 만난 동료님!", "안녕하세요, 처음 만나서 반갑습니다!"]) expect(isKoreanGreeting(greeting)).toBe(true);
  // 결함 주입: 이전의 좁은 정규식은 정상 응답을 오탐했다.
  expect(/반갑|만나/.test("안녕하세요, 처음 뵙겠습니다.")).toBe(false);
});
it("무응답·무관한 문장·언어 혼합·문장 수 위반은 거부한다", () => {
  for (const text of ["", "Hello there", "오늘 기온은 이십 도입니다.", "안녕하세요. 你好", "안녕하세요! 반갑습니다!"]) expect(isKoreanGreeting(text)).toBe(false);
});
