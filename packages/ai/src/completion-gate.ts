/**
 * 완료 판정 게이트 — 에이전트가 "끝났다"고 말할 때 그것이 사실인지 확인한다.
 *
 * **왜 필요한가.** 도구 루프는 모델이 도구를 부르지 않으면 그 턴에서 끝난다.
 * 그것이 옳은 기본 동작이다 — 모델이 답을 냈으면 루프도 끝나야 한다.
 * 그런데 실측에서 이런 일이 반복됐다:
 *
 *   s4.agent_edited — write_file called 0 time(s) — 2턴, 도구 [run_tests, read_file],
 *   모델의 마지막 응답: "To resolve the failures in the test, we will:
 *                        ### Step 1: Fix `lineTotal()` ... which is incorrect..."
 *
 * 모델은 버그를 정확히 진단하고 **고치겠다고 설명한 뒤 아무것도 하지 않았다.**
 * 루프는 규칙대로 종료했고, 결과는 "작업 완료"로 보고됐다.
 *
 * 프롬프트로 막아 보려 했으나 측정에서 기각됐다(수정 전 5/7, 후 2/3 — 구분 불가).
 * 지시는 모델이 따라야만 작동한다. 7B 는 따르지 않을 때가 있다.
 * **모델의 협조에 기대지 않는 방법이 필요하다.**
 *
 * 그래서 호출자가 '완료'의 정의를 주면 시스템이 그것을 검사한다.
 * 코드 수리라면 "테스트가 통과한다", 인덱싱이라면 "인덱스가 갱신됐다" 같은 것이다.
 * 미완이면 실패 내용을 대화에 붙여 루프를 이어 간다.
 *
 * **범용 휴리스틱을 쓰지 않는 이유:** "도구를 안 불렀으면 다그친다" 같은 규칙은
 * 단순 질문("이 코드 뭐야?")에서 잘못 발동한다. 무엇이 완료인지는 작업마다 다르고,
 * 그것을 아는 것은 루프가 아니라 호출자다. 판정자가 없으면 게이트도 없다 — 그게 맞다.
 */

/** 완료 여부와, 미완이라면 왜 미완인지. reason 은 모델에게 그대로 전달된다. */
export type CompletionCheck = () => Promise<{ done: boolean; reason: string }>;

/**
 * 미완일 때 루프를 이어 갈 수 있는 최대 횟수.
 *
 * 2인 이유: 한 번은 모델이 "설명만 하고 안 했다"를 바로잡기에 충분하고,
 * 그래도 안 되면 더 시도해도 같은 결과가 나온다 — 실측에서 그랬다.
 * 무제한이면 같은 실패를 반복하며 토큰과 시간만 태운다.
 */
export const MAX_INCOMPLETE_RETRIES = 2;

/**
 * 미완 상태를 모델에게 알리는 메시지.
 *
 * user 역할로 넣는다. system 을 도중에 바꾸면 프롬프트 캐시가 깨지고,
 * assistant 로 넣으면 모델이 자기가 한 말로 착각한다.
 *
 * 문구가 지시적인 이유: 이 시점의 모델은 이미 "끝났다"고 판단한 상태다.
 * 부드럽게 물으면 다시 설명만 하고 끝낸다 — 실제로 그랬다.
 */
export function incompleteNudge(reason: string, attempt: number, max = MAX_INCOMPLETE_RETRIES): string {
  return [
    "The task is not finished. Verification says:",
    reason.trim().slice(0, 2_000),
    "",
    "Do not explain what you would do — do it now using the tools.",
    `Then verify again. (attempt ${attempt} of ${max})`,
  ].join("\n");
}

/** 게이트 판정 결과. `proceed` 가 false 면 루프를 끝낸다. */
export interface GateDecision {
  proceed: boolean;
  error?: boolean;
  /** proceed 일 때 대화에 붙일 메시지. */
  nudge?: string;
  /** proceed 일 때 이벤트로 내보낼 사유. */
  reason?: string;
}

/**
 * 모델이 멈췄을 때 루프를 이어 갈지 판정한다.
 *
 * **왜 순수 함수로 빼는가:** 이 판정은 제품 오케스트레이터와 검증 하네스 두 곳에서 쓰인다.
 * 각자 인라인으로 쓰면 반드시 갈라진다 — 이번 작업에서만 같은 실수를 두 번 봤다
 * (docker run 환경변수, 사실 추출 파싱). 그리고 인라인이면 **결정 규칙 자체를 시험할 수 없다.**
 * 실제로 게이트를 넣고 3회 실행했는데 모델이 매번 스스로 성공해 게이트가 한 번도
 * 발동하지 않았다 — 즉 실행만으로는 이 로직이 옳은지 알 수 없었다.
 *
 * 규칙:
 *  - 판정자가 없으면 이어 가지 않는다. 무엇이 완료인지 모르는 채 다그치면 오작동한다.
 *  - 상한을 넘겼으면 끝낸다. 같은 실패를 무한 반복하는 것이 최악이다.
 *  - 판정 예외는 성공이 아니다. 재시도는 멈추되 검증 실패를 명시한다.
 */
export async function evaluateCompletion(opts: {
  check?: CompletionCheck;
  retriesSoFar: number;
  max?: number;
}): Promise<GateDecision> {
  const max = opts.max ?? MAX_INCOMPLETE_RETRIES;
  if (!opts.check || opts.retriesSoFar >= max) return { proceed: false };

  let verdict: { done: boolean; reason: string };
  try {
    verdict = await opts.check();
  } catch {
    return { proceed: false, error: true, reason: "완료 검증 실행에 실패했습니다." };
  }
  if (verdict.done) return { proceed: false };

  const attempt = opts.retriesSoFar + 1;
  return { proceed: true, reason: verdict.reason, nudge: incompleteNudge(verdict.reason, attempt, max) };
}
