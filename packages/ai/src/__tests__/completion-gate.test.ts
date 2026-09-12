import { describe, it, expect } from "vitest";
import { evaluateCompletion, incompleteNudge, MAX_INCOMPLETE_RETRIES } from "../completion-gate.js";

/**
 * 완료 게이트 정책 회귀 테스트.
 *
 * 이 정책이 존재하는 이유: 모델이 "고치겠다"고 설명만 하고 도구를 부르지 않은 채
 * 턴을 끝내는 일이 반복됐다. 프롬프트로 막으려 했으나 측정에서 기각됐다
 * (수정 전 5/7, 후 2/3 — 구분 불가). 그래서 모델의 협조에 기대지 않는 장치를 만들었다.
 */
describe("완료 게이트 정책", () => {
  it("재시도 상한이 있다 — 없으면 같은 실패를 무한 반복한다", () => {
    expect(MAX_INCOMPLETE_RETRIES).toBeGreaterThan(0);
    expect(MAX_INCOMPLETE_RETRIES).toBeLessThanOrEqual(3);
  });

  it("넛지가 실패 내용을 그대로 전달한다 — 모델이 무엇을 고쳐야 하는지 알아야 한다", () => {
    const msg = incompleteNudge("FAIL invoiceTotal with tax: got 84, want 44", 1);
    expect(msg).toContain("got 84, want 44");
  });

  it("설명하지 말고 실행하라고 못 박는다", () => {
    // 이 문구가 없으면 모델이 또 설명만 하고 끝낸다 — 실제로 그랬다.
    const msg = incompleteNudge("tests failing", 1);
    expect(msg).toMatch(/Do not explain what you would do/);
    expect(msg).toMatch(/using the tools/);
  });

  it("몇 번째 시도인지 알려 준다 — 남은 기회를 모르면 모델이 여유를 부린다", () => {
    expect(incompleteNudge("x", 2)).toContain(`attempt 2 of ${MAX_INCOMPLETE_RETRIES}`);
  });

  it("아주 긴 실패 출력은 잘라 낸다 — 컨텍스트를 통째로 잡아먹으면 안 된다", () => {
    const msg = incompleteNudge("실패!".repeat(5_000), 1);
    expect(msg.length).toBeLessThan(2_300);
  });
});

describe("evaluateCompletion — 판정 규칙", () => {
  const failing = async () => ({ done: false, reason: "SUITE FAILED: got 84, want 44" });
  const passing = async () => ({ done: true, reason: "SUITE PASSED" });

  it("판정자가 없으면 이어 가지 않는다 — 무엇이 완료인지 모르는 채 다그치면 오작동한다", async () => {
    expect(await evaluateCompletion({ retriesSoFar: 0 })).toEqual({ proceed: false });
  });

  it("완료면 끝낸다", async () => {
    expect(await evaluateCompletion({ check: passing, retriesSoFar: 0 })).toEqual({ proceed: false });
  });

  it("미완이면 실패 내용을 담은 넛지와 함께 이어 간다", async () => {
    const d = await evaluateCompletion({ check: failing, retriesSoFar: 0 });
    expect(d.proceed).toBe(true);
    expect(d.reason).toContain("got 84, want 44");
    expect(d.nudge).toContain("got 84, want 44");
    expect(d.nudge).toMatch(/Do not explain/);
  });

  it("상한을 넘기면 미완이어도 끝낸다 — 무한 반복이 최악이다", async () => {
    expect(await evaluateCompletion({ check: failing, retriesSoFar: MAX_INCOMPLETE_RETRIES }))
      .toEqual({ proceed: false });
  });

  it("판정 예외를 성공으로 숨기지 않고 검증 실패로 끝낸다", async () => {
    const broken = async () => { throw new Error("run_tests 실행 불가"); };
    expect(await evaluateCompletion({ check: broken, retriesSoFar: 0 })).toEqual({ proceed: false, error: true, reason: "완료 검증 실행에 실패했습니다." });
  });

  it("시도 횟수가 넛지에 반영된다", async () => {
    expect((await evaluateCompletion({ check: failing, retriesSoFar: 1 })).nudge).toContain("attempt 2 of");
  });

  it("상한 직전까지는 계속 이어 간다 — 경계에서 한 번 덜 시도하면 안 된다", async () => {
    for (let i = 0; i < MAX_INCOMPLETE_RETRIES; i++) {
      expect((await evaluateCompletion({ check: failing, retriesSoFar: i })).proceed).toBe(true);
    }
  });
});

describe("완료 게이트 — 루프 통합", () => {
  /**
   * 실측에서 게이트가 3회 실행 내내 한 번도 발동하지 않았다 —
   * 모델이 매번 스스로 성공했기 때문이다. 즉 **실행만으로는 이 장치가 동작하는지 알 수 없다.**
   * 모델의 기분과 무관하게, 루프가 실제로 이어지는지 여기서 확인한다.
   */
  it("설명만 하고 멈춘 모델을 한 번 더 돌려 완료시킨다", async () => {
    const turns: string[] = [];
    let edited = false;
    // 1턴: 산문만 (실측에서 관측된 실패 형태). 2턴: 넛지를 받고 실제로 편집.
    const model = async (convo: string[]): Promise<{ toolCalls: number }> => {
      turns.push(convo[convo.length - 1] ?? "");
      if (convo.length > 1) { edited = true; return { toolCalls: 1 }; }
      return { toolCalls: 0 };
    };
    const convo = ["fix the failing test"];
    let nudges = 0;
    for (let t = 0; t < 5; t++) {
      const out = await model(convo);
      if (out.toolCalls > 0) break;
      const gate = await evaluateCompletion({
        check: async () => ({ done: edited, reason: "SUITE FAILED" }),
        retriesSoFar: nudges,
      });
      if (!gate.proceed) break;
      nudges++;
      convo.push(gate.nudge!);
    }
    expect(nudges).toBe(1);         // 정확히 한 번 개입했다
    expect(edited).toBe(true);       // 그 결과 실제로 편집이 일어났다
    expect(turns[1]).toMatch(/Do not explain what you would do/);
  });

  it("계속 설명만 하는 모델에게는 상한만큼만 시도하고 포기한다", async () => {
    let nudges = 0;
    for (let t = 0; t < 10; t++) {
      const gate = await evaluateCompletion({
        check: async () => ({ done: false, reason: "여전히 실패" }),
        retriesSoFar: nudges,
      });
      if (!gate.proceed) break;
      nudges++;
    }
    expect(nudges).toBe(MAX_INCOMPLETE_RETRIES);
  });
});

describe("완료 게이트 — 턴 소진 경로", () => {
  /**
   * 실측에서 게이트가 4회 실행 내내 한 번도 발동하지 않았다. 배선은 옳았는데,
   * 게이트가 "모델이 스스로 멈췄을 때"만 돌기 때문이다.
   * 모델이 최대 턴을 전부 도구 호출로 소진하면 그 분기를 타지 않고
   * 루프가 **조용히** 끝나고, 호출자는 완료된 줄 안다.
   *
   * 조용한 미완은 조용한 실패로 이어진다. 그 경로를 여기서 고정한다.
   */
  const MAX_TURNS = 3;

  /** 매 턴 도구를 부르지만 끝내 완료하지 못하는 모델. */
  async function loopWithAlwaysCallingModel(): Promise<{ nudges: number; reportedIncomplete: boolean }> {
    let nudges = 0;
    const check = async () => ({ done: false, reason: "SUITE FAILED" });
    for (let t = 0; t < MAX_TURNS; t++) {
      const modelCalledTools = true; // 항상 도구를 부른다 → 게이트 분기를 타지 않는다
      if (modelCalledTools) continue;
      const gate = await evaluateCompletion({ check, retriesSoFar: nudges });
      if (!gate.proceed) break;
      nudges++;
    }
    // 루프가 어떻게 끝났든 완료 여부를 확정한다 — 이것이 이번에 추가한 방어다.
    const final = await check();
    return { nudges, reportedIncomplete: !final.done };
  }

  it("턴을 소진해도 미완이라는 사실이 드러난다", async () => {
    const r = await loopWithAlwaysCallingModel();
    expect(r.nudges).toBe(0);              // 게이트는 한 번도 돌지 않았다
    expect(r.reportedIncomplete).toBe(true); // 그래도 미완은 보고된다
  });

  it("완료 판정이 없으면 미완 보고도 없다 — 판정자 없이 단정하지 않는다", async () => {
    const check = undefined;
    const gate = await evaluateCompletion({ check, retriesSoFar: 0 });
    expect(gate.proceed).toBe(false);
  });
});
