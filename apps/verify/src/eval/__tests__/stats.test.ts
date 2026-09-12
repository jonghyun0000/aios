import { describe, it, expect } from "vitest";
import { wilson, rate, compare, minDetectableDelta, formatRate } from "../stats.js";

describe("Wilson 신뢰구간", () => {
  it("정규근사가 무너지는 경계에서도 의미 있는 폭을 준다", () => {
    // 5회 중 5회 통과. 정규근사면 폭이 0이 되어 "100% 확실"이라는 거짓 확신을 준다.
    const r = wilson(5, 5);
    expect(r.hi).toBe(1);
    expect(r.lo).toBeLessThan(0.9);   // 5회로는 100%를 확신할 수 없다
    expect(r.lo).toBeGreaterThan(0.4);
  });

  it("0% 에서도 구간이 [0,1] 밖으로 나가지 않는다", () => {
    const r = wilson(0, 5);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(0);
    expect(r.hi).toBeLessThanOrEqual(1);
  });

  it("표본이 늘면 구간이 좁아진다 — 이것이 반복 실행의 유일한 이유다", () => {
    const few = wilson(8, 10);
    const many = wilson(80, 100);
    expect(many.hi - many.lo).toBeLessThan(few.hi - few.lo);
  });

  it("표본이 0이면 아무것도 모른다고 말한다", () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("두 설정 비교", () => {
  it("이번 세션의 실제 관측(5/7 → 2/3)은 '구분 불가' 로 판정된다", () => {
    // 이 도구가 있었다면 "프롬프트 수정이 효과 있다"고 쓰지 않았을 것이다.
    const before = rate(5, 7);
    const after = rate(2, 3);
    expect(compare(before, after).verdict).toBe("구분 불가");
  });

  it("1회 통과로는 절대 '개선' 이 나오지 않는다", () => {
    // 1회 실행으로 결론을 낸 것이 이 도구를 만들게 된 계기다.
    expect(compare(rate(0, 1), rate(1, 1)).verdict).toBe("구분 불가");
  });

  it("표본이 충분하고 차이가 크면 개선을 인정한다", () => {
    expect(compare(rate(50, 100), rate(95, 100)).verdict).toBe("개선");
  });

  it("악화도 같은 기준으로 잡는다", () => {
    expect(compare(rate(95, 100), rate(50, 100)).verdict).toBe("악화");
  });

  it("델타는 판정과 무관하게 항상 보고한다 — 방향은 알려 줘야 한다", () => {
    const c = compare(rate(5, 7), rate(2, 3));
    expect(c.verdict).toBe("구분 불가");
    expect(c.delta).toBeCloseTo(2 / 3 - 5 / 7, 5);
  });
});

describe("탐지 가능한 최소 차이", () => {
  it("표본이 작으면 어떤 개선도 확증할 수 없다고 말한다", () => {
    // "구분 불가"를 "차이 없음"으로 오독하는 것을 막는 장치다.
    expect(minDetectableDelta(3, 0.8)).toBe(1);
  });

  it("표본이 늘수록 탐지 가능한 차이가 작아진다", () => {
    const n20 = minDetectableDelta(20, 0.8);
    const n100 = minDetectableDelta(100, 0.8);
    expect(n100).toBeLessThan(n20);
    expect(n100).toBeGreaterThan(0);
  });
});

describe("출력 형식", () => {
  it("통과율만 쓰지 않고 표본 수와 구간을 함께 낸다", () => {
    const s = formatRate(rate(8, 10));
    expect(s).toContain("80%");
    expect(s).toContain("8/10");
    expect(s).toContain("CI");
  });
});
