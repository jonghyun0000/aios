import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAppA11yOutput, inspectAppA11yReport, runAppA11y } from "./verify-app-a11y.mjs";

const report = () => ({ suites: [{ specs: [{ id: "fixture", ok: true, tests: [{ projectId: "desktop", expectedStatus: "passed", status: "expected", results: [{ status: "passed", retry: 0, errors: [] }] }] }] }], errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 } });
const leaf = value => value.suites[0].specs[0].tests[0];

test("중첩 suite의 실제 test를 합산하고 API 대역 범위를 표시한다", () => {
  const value = report(), nested = report(); nested.suites[0].specs[0].id = "nested";
  value.suites[0].suites = nested.suites; value.stats.expected = 2;
  const result = inspectAppA11yReport(value, 0);
  assert.equal(result.status, "PASS"); assert.equal(result.executed, 2); assert.equal(result.passed, 2);
  assert.match(result.scope, /합성 API\/WS/);
});
test("실제 검사 0개는 exit 0이어도 PASS가 아니다", () => {
  const value = report(); value.suites = []; value.stats.expected = 0;
  assert.equal(inspectAppA11yReport(value, 0).status, "INCOMPLETE");
});
test("전부 SKIP 및 passed와 SKIP 혼합은 PASS가 아니다", () => {
  const value = report(); Object.assign(leaf(value), { status: "skipped", expectedStatus: "skipped", results: [{ status: "skipped", retry: 0, errors: [] }] });
  Object.assign(value.stats, { expected: 0, skipped: 1 });
  assert.equal(inspectAppA11yReport(value, 0).status, "INCOMPLETE");
  const mixed = report(); value.suites[0].specs[0].id = "skip"; mixed.suites.push(...value.suites); mixed.stats.skipped = 1;
  assert.equal(inspectAppA11yReport(mixed, 0).status, "INCOMPLETE");
});
test("실패와 예상 실패 표시도 실제 성공으로 계산하지 않는다", () => {
  for (const expectedStatus of ["passed", "failed"]) {
    const value = report(); Object.assign(leaf(value), { expectedStatus, status: expectedStatus === "passed" ? "unexpected" : "expected", results: [{ status: "failed", retry: 0, errors: [{ message: "fixture" }] }] });
    if (expectedStatus === "passed") Object.assign(value.stats, { expected: 0, unexpected: 1 });
    assert.equal(inspectAppA11yReport(value, 0).status, "FAIL");
  }
});
test("재시도 성공·flaky는 첫 시도 성공으로 숨기지 않는다", () => {
  const value = report(); leaf(value).status = "flaky"; leaf(value).results.unshift({ status: "failed", retry: 0, errors: [] }); leaf(value).results[1].retry = 1;
  Object.assign(value.stats, { expected: 0, flaky: 1 }); assert.equal(inspectAppA11yReport(value, 0).status, "FAIL");
  leaf(value).status = "expected"; leaf(value).results.shift(); Object.assign(value.stats, { expected: 1, flaky: 0 });
  assert.equal(inspectAppA11yReport(value, 0).status, "FAIL");
});
test("집계 숫자와 실제 test 상태가 다르면 실패한다", () => {
  const value = report(); value.stats.expected = 36;
  assert.equal(inspectAppA11yReport(value, 0).reason, "stats_test_count_mismatch");
  value.stats.expected = 1; leaf(value).results[0].status = "failed";
  assert.equal(inspectAppA11yReport(value, 0).reason, "test_status_mismatch");
});
test("중복 test·누락된 결과·알 수 없는 상태·잘못된 집계는 실패한다", () => {
  const mutations = [
    value => value.suites.push(structuredClone(value.suites[0])),
    value => { delete leaf(value).results; },
    value => { leaf(value).results[0].status = "unknown"; },
    value => { value.stats.expected = -1; },
    value => { value.suites[0].specs[0].ok = false; },
  ];
  for (const mutate of mutations) { const value = report(); mutate(value); assert.notEqual(inspectAppA11yReport(value, 0).status, "PASS"); }
});
test("성공 JSON이라도 프로세스 실패나 전역 오류가 있으면 실패한다", () => {
  assert.equal(inspectAppA11yReport(report(), 1).status, "FAIL");
  const value = report(); value.errors.push({ message: "fixture" }); assert.equal(inspectAppA11yReport(value, 0).status, "FAIL");
});
test("JSON 누락·부분 JSON·stdout 문구 추측은 거부한다", () => {
  for (const stdout of ["", "36 passed", "{}", "null", "{", `PASS\n${JSON.stringify(report())}`, `${JSON.stringify(report())}\nextra`]) assert.equal(inspectAppA11yOutput(stdout, 0).status, "FAIL");
  assert.equal(inspectAppA11yOutput(JSON.stringify(report()), 0).status, "PASS");
});

test("이번 자식 stdout만 사용하고 옛 파일·출력 환경을 재사용하지 않는다", async () => {
  const parent = await mkdtemp(join(process.platform === "darwin" ? "/Volumes/T7/bigdata/tmp" : tmpdir(), "a11y-guard-test-"));
  try {
    const old = join(parent, "old.json"); await writeFile(old, JSON.stringify(report()));
    const args = { command: process.execPath, scratchParent: parent, timeoutMs: 3000,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: old, PLAYWRIGHT_JSON_OUTPUT_NAME: "old.json", PLAYWRIGHT_JSON_OUTPUT_DIR: parent } };
    const missing = await runAppA11y({ ...args, prefix: ["-e", "process.stdout.write('36 passed')", "--"] });
    assert.equal(missing.status, "FAIL");
    const source = `if (['PLAYWRIGHT_JSON_OUTPUT_FILE','PLAYWRIGHT_JSON_OUTPUT_NAME','PLAYWRIGHT_JSON_OUTPUT_DIR'].some(k=>process.env[k])) process.exit(3); process.stdout.write(${JSON.stringify(JSON.stringify(report()))});`;
    const passed = await runAppA11y({ ...args, prefix: ["-e", source, "--"] });
    assert.equal(passed.status, "PASS"); assert.notEqual(passed.artifacts, missing.artifacts);
    assert.deepEqual(JSON.parse(await readFile(old, "utf8")), report());
    assert.equal((await readdir(parent)).filter(name => name.startsWith("app-a11y-")).length, 2);
    const timeout = await runAppA11y({ ...args, timeoutMs: 100, prefix: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(report()))}); setInterval(()=>{},1000);`, "--"] });
    assert.equal(timeout.status, "FAIL");
  } finally { await rm(parent, { recursive: true, force: false }); }
});
