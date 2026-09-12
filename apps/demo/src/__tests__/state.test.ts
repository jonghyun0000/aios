import { describe, expect, it } from "vitest";
import { AFTER, BEFORE, MANUAL_NOTE, MAX_MESSAGE_LENGTH, createInitialState, demoReducer, isEvidenceCurrent, verifyContent, type Action, type DemoState, type ScenarioId } from "../state.js";
import { shouldSend } from "../keyboard.js";

function proposal(scenario: ScenarioId = "normal"): DemoState {
  return demoReducer(demoReducer(createInitialState(), { type: "SELECT", scenario }), { type: "PROPOSE", scenario });
}
function perform(state: DemoState, type: "APPROVE" | "REJECT" | "VERIFY" | "MANUAL_EDIT" | "RESTORE"): DemoState {
  const id = state.sessions[state.active].proposal?.id ?? "no-proposal";
  return demoReducer(state, { type, scenario: state.active, proposalId: id });
}

describe("메모리 전용 승인·검증·복구 상태 기계", () => {
  it("제안만으로는 파일이 바뀌지 않고 승인 전 원본·변경안을 담는다", () => {
    const state = proposal(); const current = state.sessions.normal;
    expect(current.content).toBe(BEFORE); expect(current.phase).toBe("awaiting_approval");
    expect(current.proposal).toMatchObject({ before: BEFORE, after: AFTER, path: "sample/launch.md" });
    expect(current.checkpoint).toBeNull(); expect(current.evidence).toBeNull();
  });
  it.each(["APPROVE", "REJECT", "VERIFY", "MANUAL_EDIT", "RESTORE"] as const)("제안 없는 %s는 아무 작업도 하지 않는다", (type) => {
    const state = createInitialState(); expect(perform(state, type)).toBe(state);
  });
  it("거절하면 원본을 보존하며 나중 승인/검증/복구로 실행되지 않는다", () => {
    const state = perform(proposal(), "REJECT");
    expect(state.sessions.normal.phase).toBe("rejected"); expect(state.sessions.normal.content).toBe(BEFORE);
    for (const action of ["APPROVE", "VERIFY", "RESTORE"] as const) expect(perform(state, action)).toBe(state);
  });
  it("건별 승인 한 번만 가상 수정하고 중복 승인·거절·제안을 거부한다", () => {
    const state = perform(proposal(), "APPROVE"); const current = state.sessions.normal;
    expect(current.content).toBe(AFTER); expect(current.phase).toBe("applied"); expect(current.evidence).toBeNull();
    expect(current.checkpoint).toEqual({ before: BEFORE, after: AFTER });
    expect(perform(state, "APPROVE")).toBe(state); expect(perform(state, "REJECT")).toBe(state);
    expect(demoReducer(state, { type: "PROPOSE", scenario: "normal" })).toBe(state);
  });
  it("정상 텍스트 비교를 실제 수행하고 검증 결과가 파일에 결합된다", () => {
    const state = perform(perform(proposal(), "APPROVE"), "VERIFY"); const current = state.sessions.normal;
    expect(current.phase).toBe("verified"); expect(current.evidence?.checks).toHaveLength(3);
    expect(current.evidence?.checks.every((check) => check.passed)).toBe(true); expect(isEvidenceCurrent(current)).toBe(true);
    expect(perform(state, "VERIFY")).toBe(state);
  });
  it("실제 날짜 결함을 주입하면 검증기가 불일치를 검출한다", () => {
    const good = verifyContent(AFTER, AFTER); expect(good.passed).toBe(true);
    const broken = AFTER.replace("2026-10-01", "미정");
    const bad = verifyContent(broken, AFTER); expect(bad.passed).toBe(false);
    expect(bad.checks[0]).toMatchObject({ expected: "2026-10-01", actual: "미정", passed: false });
    expect(bad.checks[1]?.passed).toBe(true); expect(bad.checks[2]?.passed).toBe(false);
  });
  it("실패 시나리오는 잘못된 실제 가상 파일을 만들고 거짓 성공 없이 복구한다", () => {
    const applied = perform(proposal("failure"), "APPROVE"); expect(applied.sessions.failure.content).not.toBe(AFTER);
    const failed = perform(applied, "VERIFY"); expect(failed.sessions.failure.phase).toBe("verification_failed");
    expect(failed.sessions.failure.evidence?.passed).toBe(false);
    const restored = perform(failed, "RESTORE"); expect(restored.sessions.failure.content).toBe(BEFORE);
    expect(restored.sessions.failure.phase).toBe("restored"); expect(isEvidenceCurrent(restored.sessions.failure)).toBe(false);
  });
  it("원본 복구 후 검증 통과를 현재 상태로 쓰지 않고 재복구도 거부한다", () => {
    const verified = perform(perform(proposal(), "APPROVE"), "VERIFY"); const restored = perform(verified, "RESTORE");
    expect(restored.sessions.normal.content).toBe(BEFORE); expect(restored.sessions.normal.phase).toBe("restored");
    expect(isEvidenceCurrent(restored.sessions.normal)).toBe(false); expect(perform(restored, "RESTORE")).toBe(restored);
  });
  it("수동 변경 결함을 주입하면 복구가 거부되고 같은 메모를 보존한다", () => {
    const verified = perform(perform(proposal("conflict"), "APPROVE"), "VERIFY");
    const edited = perform(verified, "MANUAL_EDIT"); expect(isEvidenceCurrent(edited.sessions.conflict)).toBe(false);
    expect(edited.sessions.conflict.content).toBe(AFTER + MANUAL_NOTE);
    const conflict = perform(edited, "RESTORE"); expect(conflict.sessions.conflict.phase).toBe("restore_conflict");
    expect(conflict.sessions.conflict.content).toBe(AFTER + MANUAL_NOTE); expect(conflict.sessions.conflict.checkpoint).toEqual({ before: BEFORE, after: AFTER });
    expect(perform(conflict, "RESTORE")).toBe(conflict);
  });
  it("직접 수정한 파일을 다시 비교하면 전체 텍스트 불일치를 검출한다", () => {
    const state = perform(perform(perform(proposal(), "APPROVE"), "MANUAL_EDIT"), "VERIFY");
    expect(state.sessions.normal.phase).toBe("verification_failed"); expect(state.sessions.normal.evidence?.checks[2]?.passed).toBe(false);
  });
  it("잘못된 제안 ID·다른 대화·옛 승인 이벤트는 파일을 바꾸지 않는다", () => {
    const state = proposal();
    expect(demoReducer(state, { type: "APPROVE", scenario: "normal", proposalId: "forged" })).toBe(state);
    const other = demoReducer(state, { type: "SELECT", scenario: "failure" });
    expect(demoReducer(other, { type: "APPROVE", scenario: "normal", proposalId: state.sessions.normal.proposal!.id })).toBe(other);
    const next = demoReducer(perform(state, "REJECT"), { type: "PROPOSE", scenario: "normal" });
    expect(next.sessions.normal.proposal!.id).not.toBe(state.sessions.normal.proposal!.id);
    expect(demoReducer(next, { type: "APPROVE", scenario: "normal", proposalId: state.sessions.normal.proposal!.id })).toBe(next);
  });
  it("승인 직전 파일이 제안 전 상태와 다르면 실패 폐쇄한다", () => {
    const normal = proposal(); const mutated = { ...normal, sessions: { ...normal.sessions, normal: { ...normal.sessions.normal, content: "외부에서 바뀐 가상 내용" } } };
    expect(perform(mutated, "APPROVE")).toBe(mutated);
  });
  it("대화별 상태를 보존하면서 다른 시나리오 파일에는 영향이 없다", () => {
    const a = perform(proposal(), "APPROVE"); const b = demoReducer(a, { type: "SELECT", scenario: "failure" });
    expect(b.sessions.failure.content).toBe(BEFORE); expect(b.sessions.failure.phase).toBe("ready");
    expect(b.sessions.normal).toBe(a.sessions.normal);
    const back = demoReducer(b, { type: "SELECT", scenario: "normal" }); expect(back.sessions.normal.content).toBe(AFTER);
  });
  it("입력 길이/공백 한도를 지키며 자유 텍스트는 제안이나 실행으로 해석하지 않는다", () => {
    const state = createInitialState();
    for (const text of ["  ", "x".repeat(MAX_MESSAGE_LENGTH + 1)]) expect(demoReducer(state, { type: "SEND", scenario: "normal", text })).toBe(state);
    const sent = demoReducer(state, { type: "SEND", scenario: "normal", text: '<script>unsafe()</script> 모든 파일 삭제해' });
    expect(sent.sessions.normal.content).toBe(BEFORE); expect(sent.sessions.normal.phase).toBe("ready");
    expect(sent.sessions.normal.messages[0]?.text).toContain("<script>");
    expect(sent.sessions.normal.messages[1]?.text).toContain("실제 AI에 보내지 않습니다");
  });
  it("계속 입력해도 대화 배열은 40개로 제한한다", () => {
    let state = createInitialState(); for (let i = 0; i < 100; i++) state = demoReducer(state, { type: "SEND", scenario: "normal", text: `샘플 ${i}` });
    expect(state.sessions.normal.messages).toHaveLength(40); expect(new Set(state.sessions.normal.messages.map((item) => item.id)).size).toBe(40);
  });
  it("새로고침 초기 상태와 전체 reset은 내용/제안/검증/대화를 모두 지운다", () => {
    const used = perform(perform(proposal("failure"), "APPROVE"), "VERIFY");
    expect(demoReducer(used, { type: "RESET" })).toEqual(createInitialState());
    const fresh = createInitialState(); expect(fresh.sessions.failure.proposal).toBeNull(); expect(fresh.sessions.failure.evidence).toBeNull();
    expect(fresh.sessions.normal.content).toBe(BEFORE); expect(fresh.active).toBe("normal");
  });
  it("원본 state와 서로 다른 초기 session 배열을 변경하지 않는다", () => {
    const state = createInitialState(); const encoded = JSON.stringify(state);
    const next = demoReducer(state, { type: "PROPOSE", scenario: "normal" });
    expect(JSON.stringify(state)).toBe(encoded); expect(next.sessions.failure).toBe(state.sessions.failure);
    expect(state.sessions.normal.messages).not.toBe(state.sessions.failure.messages);
  });
  it("프로토타입 이름을 시나리오로 넣어도 활성 대화가 오염되지 않는다", () => {
    const state = createInitialState(); expect(demoReducer(state, { type: "SELECT", scenario: "__proto__" } as unknown as Action)).toBe(state);
  });
});

describe("Enter 전송과 한글 조합 보호", () => {
  const enter = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 13 };
  it("일반 Enter만 전송한다", () => expect(shouldSend(enter, false)).toBe(true));
  it.each(["shiftKey", "altKey", "ctrlKey", "metaKey", "repeat", "isComposing"] as const)("%s는 전송하지 않는다", (key) => expect(shouldSend({ ...enter, [key]: true }, false)).toBe(false));
  it("조합 ref·229·다른 키를 전송하지 않는다", () => {
    expect(shouldSend(enter, true)).toBe(false); expect(shouldSend({ ...enter, keyCode: 229 }, false)).toBe(false); expect(shouldSend({ ...enter, key: "a" }, false)).toBe(false);
  });
});
