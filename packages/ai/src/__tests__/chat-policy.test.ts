import { describe, expect, it } from "vitest";
import { calculate, chooseChatStrategy } from "../chat-policy.js";

describe("자동 응답 정책 / 정확 계산", () => {
  it.each([
    ["What is 17 * 23 + 41? Reply with only the number.", "432"], ["17 + 25는? 다른 설명 없이 정답 숫자만 답하세요.", "42"],
    ["0.1 + 0.2", "0.3"], ["(17+23)*2", "80"], ["-3 * (2 - 7)", "15"], [".5 / .2", "2.5"], ["1/3+1/6", "0.5"], ["1 / 3", "1/3"],
    ["9007199254740993 + 1", "9007199254740994"], ["계산해줘: 8 ÷ 4 × 3", "6"], ["2-2", "0"],
  ])("%s → %s", (input, expected) => expect(calculate(input)).toMatchObject({ text: expected, ok: true }));
  it.each(["2026-09-12", "010-1234-5678", "2026-09-12에 할 일", "Explain why 2+2=4", "2+2 한국어로 한 문장", "17 * 23 코드 작성", "2**100000", "1e309+1", "process.exit()+1", "1+globalThis.secret", "1..2+3", "(1+2", "2(3+4)", "1 2+3", "https://a.test/2+3", "2^3", "1+" ])("모호하거나 실행 가능한 입력 거부: %s", (input) => expect(calculate(input)).toBeNull());
  it("0 나눗셈은 지어낸 숫자를 반환하지 않는다", () => expect(calculate("1 / 0")).toMatchObject({ ok: false, text: "0으로 나눌 수 없습니다." }));
  it("독립 정수 기준으로 1,323개 부호·우선순위 조합을 대조한다", () => {
    for (let a = -10; a <= 10; a++) for (let b = -10; b <= 10; b++) {
      expect(calculate(`(${a})+(${b})*3`)?.text).toBe(String(a + b * 3));
      expect(calculate(`((${a})+(${b}))*3`)?.text).toBe(String((a + b) * 3));
      expect(calculate(`(${a})-(${b})`)?.text).toBe(String(a - b));
    }
  });
  it("자동만 계산을 우회하고 직접 선택·도구 권한을 존중한다", () => {
    expect(chooseChatStrategy("17*23+41", "auto", false).path).toBe("calculator");
    expect(chooseChatStrategy("17*23+41", "fast", false).path).toBe("fast");
    expect(chooseChatStrategy("17*23+41", "auto", true).path).toBe("thorough");
    expect(chooseChatStrategy("안녕", "auto", false).path).toBe("fast");
    expect(chooseChatStrategy('Reply only {"ok":true}, no code fences.', "auto", false).path).toBe("fast");
    expect(chooseChatStrategy('Reply exactly [3,2,1] without spaces or code fences.', "auto", false).path).toBe("fast");
    expect(chooseChatStrategy("문장을 한국어로 번역해줘", "auto", false).path).toBe("thorough");
    expect(chooseChatStrategy("TypeScript function sumEven 구현", "auto", false).path).toBe("thorough");
  });
  it("짧은 단일 함수 작성과 변경·위험 작업을 구별한다", () => {
    const prompt = "Write a TypeScript function increment(x:number):number returning x plus one.";
    expect(chooseChatStrategy(prompt, "auto", false).path).toBe("fast");
    expect(chooseChatStrategy(prompt, "auto", true).path).toBe("thorough");
    expect(chooseChatStrategy(`${prompt} Fix a security bug.`, "auto", false).path).toBe("thorough");
    expect(chooseChatStrategy(`${prompt} Use recursion.`, "auto", false).path).toBe("thorough");
  });
  it("결함 주입: 모델 오답·소수 부동소수점 경로를 검사기가 검출한다", () => {
    const check = (value: string) => expect(value).toBe("432");
    expect(() => check("403")).toThrow(); check(calculate("17*23+41")!.text);
    expect(() => expect(String(0.1 + 0.2)).toBe("0.3")).toThrow();
  });
});
