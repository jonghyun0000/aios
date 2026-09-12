import { createContext, runInContext } from "node:vm";
import { transformSync } from "esbuild";

/**
 * 모델이 쓴 코드 조각을 실제로 실행해 채점한다.
 *
 * **왜 패턴 매칭을 버렸는가.** 처음에는 정규식으로 "세금을 두 번 더했는가"를 봤다.
 * 채점기 시험을 짜자마자 그 채점기가 **오답을 정답으로 통과시키는 것**이 드러났다
 * (`subtotal + subtotal * (1 + rate/100)` 를 잡지 못했다).
 * 코드가 맞는지 아는 방법은 실행해 보는 것뿐이다 — 형태를 추측하면 반드시 틀린다.
 *
 * **격리:** `node:vm` 에 빈 컨텍스트를 주고 시간 제한을 건다.
 * require·process·fs 가 없으므로 조각이 바깥에 손댈 수 없다.
 * vm 은 완전한 보안 경계가 아니지만(같은 프로세스다), 여기서 도는 것은
 * 우리가 낸 과제에 대한 로컬 모델의 답이지 신뢰할 수 없는 입력이 아니다.
 * 무한 루프로 검증을 멈추게 하는 것이 현실적 위험이고, 시간 제한이 그것을 막는다.
 */

/**
 * TypeScript → JavaScript.
 *
 * **정규식으로 타입을 걷어내려다 실제로 데였다.** `:\s*타입` 을 지우는 규칙이
 * **삼항 연산자의 `: else` 절까지 먹었다**:
 *
 *   원본  : xs.reduce((sum, x) => x % 2 === 0 ? sum + x : sum, 0)
 *   변환후: xs.reduce((sum, x) => x % 2 === 0 ? sum + x , 0)      ← 문법 파괴
 *
 * 그 결과 **정답을 오답으로 판정했다**(code.even-sum 0/3). 채점기가 멀쩡한 모델을
 * 나쁘다고 말하는 것이 이 도구가 낼 수 있는 최악의 결과다.
 * 언어를 정규식으로 파싱하지 않는다 — 파서를 쓴다.
 */
function toJs(code: string): string {
  const src = code.replace(/```[a-z]*\n?|```/g, "").replace(/\bexport\s+/g, "");
  // format 을 지정하지 않는다 — iife 로 감싸면 최상위 선언이 클로저에 갇혀
  // 호출할 방법이 없어진다(실제로 그렇게 모든 코드 과제가 실패했다).
  return transformSync(src, { loader: "ts", target: "es2022" }).code;
}

export interface SnippetResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** 조각에서 함수를 꺼내 인자로 호출한다. 던지거나 시간을 넘기면 실패로 본다. */
export function callSnippet(code: string, fnName: string, args: unknown[], timeoutMs = 1_000): SnippetResult {
  try {
    const src = toJs(code);
    const ctx = createContext(Object.create(null) as object);
    /*
     * 조각과 노출 코드를 **한 스크립트로** 돌린다.
     * `const f = ...` 는 스크립트 렉시컬 스코프에 묶여 globalThis 에 붙지 않고,
     * runInContext 를 두 번 부르면 그 바인딩이 사라진다. 함수 선언이든 const 든
     * 같은 스크립트 안에서 globalThis 에 실어 두어야 다음 호출에서 보인다.
     */
    runInContext(
      `${src}\n;globalThis[${JSON.stringify(fnName)}] = typeof ${fnName} !== "undefined" ? ${fnName} : undefined;`,
      ctx, { timeout: timeoutMs });
    const fn = (ctx as Record<string, unknown>)[fnName];
    if (typeof fn !== "function") return { ok: false, error: `${fnName} 이(가) 정의되지 않았다` };
    const value = runInContext(
      `${fnName}(${args.map((a) => JSON.stringify(a)).join(", ")})`,
      ctx,
      { timeout: timeoutMs },
    );
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 여러 입출력 쌍을 전부 만족하는가. 하나라도 틀리면 실패다. */
export function satisfies(
  code: string,
  fnName: string,
  cases: { args: unknown[]; expect: unknown }[],
): boolean {
  return cases.every((c) => {
    const r = callSnippet(code, fnName, c.args);
    return r.ok && Object.is(r.value, c.expect);
  });
}
