import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approveFixtureAction, assertOwnedSession, assertReference, RELEASE_FIXTURES, workflowFixture } from "../representative-workflow.js";

const runId = "a1100000-0000-4000-8000-000000000001";
const fixture = workflowFixture(runId, RELEASE_FIXTURES[0]!);
type Action = Parameters<typeof approveFixtureAction>[0];
const write: Action = { id: "a1100000-0000-4000-8000-000000000002", run_id: runId, tool_name: "write_file", purpose: "tool", status: "pending", arguments: { path: fixture.path }, preview: { before: null, after: fixture.content }, before_hash: null, after_hash: createHash("sha256").update(fixture.content).digest("hex"), checkpoint: true, exit_code: null, output: "", decided_at: null, restored_at: null };
const verification: Action = { ...write, id: "a1100000-0000-4000-8000-000000000003", tool_name: "run_command", purpose: "verification", arguments: { command: fixture.command, cwd: "." }, preview: null, checkpoint: false, after_hash: null };
const context: Parameters<typeof assertReference>[0] = { type: "workspace_context", historyCount: 2, sources: [{ id: "R1", fileName: fixture.referenceName, startLine: 1, endLine: 6 }], memory: { enabled: true, scannedUserMessages: 1, restoredPreferences: [{ kind: "language", value: "ko" }] } };

describe("대표 업무 실사용 시험의 결정적 안전 경계", () => {
  it("3개 고정 자료는 서로 다르고 미정 가격을 그대로 유지한다", () => {
    const all = RELEASE_FIXTURES.map(f => workflowFixture(runId, f));
    expect(new Set(all.map(f => f.path)).size).toBe(3);
    expect(new Set(all.map(f => f.content)).size).toBe(3);
    for (const item of all) { expect(item.content.split("\n")).toHaveLength(5); expect(item.content).toMatch(/가격: 미정$/); }
  });
  it("경로·셸 주입을 생성 단계에서 거부한다", () => {
    for (const bad of ["../user", "' ; exit 0 #", "", runId + "/../user"]) expect(() => workflowFixture(bad, RELEASE_FIXTURES[0]!)).toThrow();
    expect(() => workflowFixture(runId, { ...RELEASE_FIXTURES[0]!, id: "../../user" })).toThrow();
  });
  it("지정한 새 파일·정확한 해시·허용한 마지막 LF만 승인한다", () => {
    expect(approveFixtureAction(write, fixture, false)).toBe(true);
    const withLf = fixture.content + "\n";
    expect(approveFixtureAction({ ...write, preview: { before: null, after: withLf }, after_hash: createHash("sha256").update(withLf).digest("hex") }, fixture, false)).toBe(true);
    expect(approveFixtureAction(write, fixture, true)).toBe(false);
  });
  it("결함 주입: 다른 경로·추측 가격·기존 파일·손상 해시·추가 인자를 거부한다", () => {
    for (const bad of [
      { ...write, arguments: { path: "user.txt" } }, { ...write, arguments: { path: "../" + fixture.path } },
      { ...write, arguments: { path: fixture.path, content: fixture.content } },
      { ...write, preview: { before: "사용자 기존 내용", after: fixture.content } },
      { ...write, preview: { before: null, after: fixture.content.replace("미정", "10000원") } },
      { ...write, after_hash: "wrong" }, { ...write, checkpoint: false }, { ...write, before_hash: "existing" },
      { ...write, status: "approved" }, { ...write, id: "wrong" },
    ]) expect(approveFixtureAction(bad, fixture, false)).toBe(false);
  });
  it("시스템 지정 검증은 쓰기 승인 후 정확한 명령·cwd·purpose만 허용한다", () => {
    expect(approveFixtureAction(verification, fixture, true)).toBe(true);
    expect(approveFixtureAction(verification, fixture, false)).toBe(false);
    expect(approveFixtureAction({ ...verification, purpose: "tool" }, fixture, true)).toBe(false);
    expect(approveFixtureAction({ ...verification, arguments: { command: "echo RELEASE_SUMMARY_VERIFIED; exit 0", cwd: "." } }, fixture, true)).toBe(false);
    expect(approveFixtureAction({ ...verification, arguments: { command: fixture.command, cwd: ".." } }, fixture, true)).toBe(false);
  });
  it("출처는 실제 제공 자료의 모든 사실을 포함한 유효 구간이어야 한다", () => {
    expect(assertReference(context, fixture)).toHaveLength(1);
    for (const sources of [[], [{ id: "R1", fileName: "다른 사용자 자료", startLine: 1, endLine: 6 }], [{ id: "R1", fileName: fixture.referenceName, startLine: 1, endLine: 2 }], [{ id: "R1", fileName: fixture.referenceName, startLine: -1, endLine: 100 }]]) expect(() => assertReference({ ...context, sources }, fixture)).toThrow();
  });
  it("기억이 실제 전달되지 않거나 선호를 복원하지 않았다면 통과시키지 않는다", () => {
    expect(() => assertReference(undefined, fixture)).toThrow();
    expect(() => assertReference({ ...context, historyCount: 0 }, fixture)).toThrow();
    expect(() => assertReference({ ...context, memory: { ...context.memory, enabled: false } }, fixture)).toThrow();
    expect(() => assertReference({ ...context, memory: { ...context.memory, restoredPreferences: [] } }, fixture)).toThrow();
  });
  it("세션 정리는 생성 id·조직·정확 UUID제목·미삭제 상태가 모두 일치해야 한다", () => {
    const expected = { id: runId, orgId: "org-fixture", title: fixture.title };
    const actual = { id: runId, org_id: "org-fixture", title: fixture.title, deleted_at: null };
    expect(() => assertOwnedSession(actual, expected)).not.toThrow();
    for (const bad of [{ ...actual, id: write.id }, { ...actual, org_id: "other" }, { ...actual, title: "동명의 사용자 대화" }, { ...actual, deleted_at: "already-trashed" }]) expect(() => assertOwnedSession(bad, expected)).toThrow();
  });
});
