/**
 * eval 통계 — "차이가 진짜인가"를 판정한다.
 *
 * **왜 이 파일이 존재하는가.** 로컬 모델은 같은 입력에도 다르게 답한다.
 * 실제로 이 저장소에서 프롬프트를 고친 뒤 1회 실행이 통과하자 "효과 있다"고 기록했고,
 * 두 번 더 돌리자 결론이 뒤집혔다(수정 전 5/7, 후 2/3 — 구분 불가).
 * 그 실수는 판단력의 문제가 아니라 **도구의 문제**였다 —
 * 통과율만 보여 주고 불확실성을 보여 주지 않으면 누구나 같은 결론을 낸다.
 *
 * 그래서 이 모듈은 통과율과 함께 **신뢰구간**을, 비교할 때는
 * **"구분 가능한가"** 를 반드시 함께 낸다.
 */

/**
 * Wilson 점수 신뢰구간.
 *
 * 정규근사(p ± 1.96·√(p(1-p)/n))를 쓰지 않는 이유: n 이 작거나 p 가 0/1 에 가까울 때
 * 구간이 [0,1] 밖으로 나가거나 폭이 0이 된다. eval 은 정확히 그 영역에서 돈다 —
 * 과제당 반복이 5~20회이고 통과율이 0% 또는 100% 인 과제가 흔하다.
 * Wilson 은 그 경계에서도 의미 있는 폭을 준다.
 */
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

export interface Rate {
  successes: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

export function rate(successes: number, n: number): Rate {
  const { lo, hi } = wilson(successes, n);
  return { successes, n, rate: n === 0 ? 0 : successes / n, lo, hi };
}

export type Verdict = "개선" | "악화" | "구분 불가";

/**
 * 두 설정을 비교한다.
 *
 * 판정 규칙: **신뢰구간이 겹치지 않을 때만** 차이를 인정한다.
 *
 * 이것은 정식 차이 검정보다 **보수적이다** — 실제로는 차이가 있는데 "구분 불가"로
 * 판정하는 경우가 생긴다. 그 방향을 일부러 택했다.
 * 이 도구가 막아야 하는 실패는 "없는 개선을 있다고 주장하는 것"이고,
 * 그 반대(있는 개선을 놓치는 것)는 관측을 더 쌓으면 해결된다.
 * 잘못된 주장은 문서에 남아 다음 사람을 오도한다 — 실제로 그렇게 됐다.
 */
export function compare(before: Rate, after: Rate): { verdict: Verdict; delta: number } {
  const delta = after.rate - before.rate;
  if (after.lo > before.hi) return { verdict: "개선", delta };
  if (after.hi < before.lo) return { verdict: "악화", delta };
  return { verdict: "구분 불가", delta };
}

/**
 * 이 표본 크기로 **탐지할 수 있는 최소 차이**.
 *
 * 왜 이걸 출력해야 하는가: "구분 불가" 라는 결과를 받은 사람은
 * "차이가 없다" 로 읽기 쉽다. 실제로는 "이 표본으로는 알 수 없다" 이다.
 * 둘은 완전히 다른 말이고, 그 구분을 사람의 해석에 맡기면 안 된다.
 *
 * 기준점 p 에서 시작해 통과율을 올려 가며 구간이 갈라지는 첫 지점을 찾는다.
 */
export function minDetectableDelta(n: number, baselineRate = 0.8): number {
  if (n === 0) return 1;
  const base = rate(Math.round(baselineRate * n), n);
  for (let k = Math.round(baselineRate * n); k <= n; k++) {
    if (rate(k, n).lo > base.hi) return k / n - base.rate;
  }
  return 1; // 이 표본으로는 어떤 개선도 확증할 수 없다
}

/** 사람이 읽을 한 줄. 통과율만 쓰지 않는다 — 구간이 없으면 오독한다. */
export function formatRate(r: Rate): string {
  return `${(r.rate * 100).toFixed(0)}% (${r.successes}/${r.n}, 95% CI ${(r.lo * 100).toFixed(0)}~${(r.hi * 100).toFixed(0)}%)`;
}
