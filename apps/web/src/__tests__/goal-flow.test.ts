import { describe, expect, it } from "vitest";
import { presentRun, RESUME_LIMIT, type FlowRun } from "../lib/goal-flow.js";

const run = (over: Partial<FlowRun> = {}): FlowRun => ({ id: "r1", status: "cancelled", summary: "실행을 중단했습니다.", created_at: "2026-09-27T00:00:00Z", goal: "sum.js 만들기", resumed_from: null, verification_command: "node sum.js",
  actions: [{ id: "a1", tool_name: "write_file", status: "passed", purpose: "tool", arguments: { path: "sum.js" }, exit_code: null, after_hash: "8781bbc29fce1234" }], ...over });

describe("목표 → 단계 → 결과", () => {
  it("중단된 실행: 목표, 실제 단계, 저장 파일, 검증 미실행, 완료되지 않음, 이어서 하기 가능", () => {
    const flow = presentRun(run(), [run()]);
    expect(flow.goal).toBe("sum.js 만들기");
    expect(flow.steps).toEqual([{ id: "a1", text: "1. 파일 쓰기: sum.js", state: "완료", tone: "ok" }]);
    expect(flow.files).toEqual([{ path: "sum.js", hash: "8781bbc29fce", state: "saved" }]);
    expect(flow.verification).toEqual({ command: "node sum.js", exitCode: null, ran: false, passed: false });
    expect(flow.verdict.tone).toBe("err");
    expect(flow.resume).toEqual({ allowed: true, reason: `이어서 하기 1/${RESUME_LIMIT}` });
  });
  it("이어서 한 실행: 변경 없음 단계, 검증 종료 코드 0이면 검증 통과, 다시 이어서 하기 불가", () => {
    const next = run({ id: "r2", status: "verified", resumed_from: "r1", actions: [
      { id: "b1", tool_name: "write_file", status: "unchanged", purpose: "tool", arguments: { path: "sum.js" }, exit_code: null, after_hash: "8781bbc29fce1234" },
      { id: "b2", tool_name: "run_command", status: "passed", purpose: "verification", arguments: { command: "node sum.js" }, exit_code: 0, after_hash: null }] });
    const flow = presentRun(next, [next, run()]);
    expect(flow.steps.map((s) => s.state)).toEqual(["변경 없음(이미 같은 내용)", "완료 · 종료 코드 0"]);
    expect(flow.files[0]!.state).toBe("unchanged");
    expect(flow.verification).toMatchObject({ exitCode: 0, passed: true });
    expect(flow.verdict.tone).toBe("ok"); expect(flow.resumedFrom).toBe("r1");
    expect(flow.resume.allowed).toBe(false);
    // 원래 실행은 이미 이어서 했으므로 다시 이어서 할 수 없다.
    expect(presentRun(run(), [next, run()]).resume.allowed).toBe(false);
  });
  it("검증 명령이 0이 아니면 통과가 아니다", () => {
    const flow = presentRun(run({ status: "failed", actions: [{ id: "c", tool_name: "run_command", status: "failed", purpose: "verification", arguments: { command: "node sum.js" }, exit_code: 1, after_hash: null }] }), []);
    expect(flow.verification).toMatchObject({ passed: false, ran: true, exitCode: 1 }); expect(flow.steps[0]!.tone).toBe("err");
  });
  it(`이어서 하기는 체인당 ${RESUME_LIMIT}회까지`, () => {
    const chain = Array.from({ length: RESUME_LIMIT + 1 }, (_, i) => run({ id: `r${i}`, resumed_from: i ? `r${i - 1}` : null, status: "failed" }));
    expect(presentRun(chain[RESUME_LIMIT - 1]!, chain.slice(0, RESUME_LIMIT)).resume.allowed).toBe(true);
    expect(presentRun(chain[RESUME_LIMIT]!, chain).resume).toMatchObject({ allowed: false, reason: expect.stringContaining(`${RESUME_LIMIT}회`) });
  });
  it("검증·진행 중·복구된 실행과 목표 없는 옛 기록", () => {
    for (const status of ["verified", "running", "restored"]) expect(presentRun(run({ status }), []).resume.allowed).toBe(false);
    const old = presentRun(run({ goal: null }), []);
    expect(old.goalRecorded).toBe(false); expect(old.goal).toContain("목표 기록 없음");
  });
});
