#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
const SCOPE = "실제 앱 화면·키보드·접근성 → 합성 API/WS 대역; 실제 DB·모델·파일 복원 시험 아님";
const outcomes = ["expected", "unexpected", "flaky", "skipped"];
const statuses = ["passed", "failed", "timedOut", "skipped", "interrupted"];
const count = value => Number.isSafeInteger(value) && value >= 0;
const invalid = reason => ({ status: "FAIL", reason, total: 0, executed: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, scope: SCOPE });

/** 실제 leaf 결과를 센 뒤 Playwright의 집계와 대조한다. expected failure도 성공 근거가 아니다. */
export function inspectAppA11yReport(report, exitCode) {
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || !report.stats
    || outcomes.some(key => !count(report.stats[key]))) return invalid("invalid_playwright_report");
  const tests = [], seen = new Set();
  let specsOk = true;
  const visit = suites => {
    for (const suite of suites) {
      if (!suite || !Array.isArray(suite.specs) || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error();
      for (const spec of suite.specs) {
        if (!spec || typeof spec.id !== "string" || !spec.id || typeof spec.ok !== "boolean" || !Array.isArray(spec.tests) || !spec.tests.length) throw new Error();
        specsOk &&= spec.ok;
        for (const test of spec.tests) {
          if (!test || typeof test.projectId !== "string" || !Array.isArray(test.results)
            || !outcomes.includes(test.status) || !statuses.includes(test.expectedStatus)) throw new Error();
          const key = JSON.stringify([spec.id, test.projectId]);
          if (seen.has(key)) throw new Error();
          seen.add(key); tests.push(test);
        }
      }
      visit(suite.suites ?? []);
    }
  };
  try { visit(report.suites); } catch { return invalid("invalid_playwright_tests"); }
  const actual = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  let executed = 0, passed = 0;
  for (const test of tests) {
    let expected = 0, unexpected = 0, skipped = 0;
    for (const result of test.results) {
      if (!result || !statuses.includes(result.status) || !count(result.retry) || !Array.isArray(result.errors)) return invalid("invalid_playwright_result");
      if (result.status === "interrupted") continue;
      if (result.status === "skipped") { if (test.expectedStatus === "skipped") skipped++; continue; }
      if (result.status === test.expectedStatus) expected++; else unexpected++;
    }
    // Playwright의 outcome 규칙과 같은 의미로 재계산하되, 최종 PASS는 첫 시도 passed만 허용한다.
    const outcome = !expected && !unexpected ? "skipped" : !unexpected ? "expected" : !expected && !skipped ? "unexpected" : "flaky";
    if (test.status !== outcome) return invalid("test_status_mismatch");
    actual[outcome]++;
    if (test.results.some(result => result.status !== "skipped")) executed++;
    const only = test.results[0];
    if (test.expectedStatus === "passed" && outcome === "expected" && test.results.length === 1
      && only.status === "passed" && only.retry === 0 && !only.error && only.errors.length === 0) passed++;
  }
  if (outcomes.some(key => actual[key] !== report.stats[key])) return invalid("stats_test_count_mismatch");
  const failed = executed - passed;
  const failure = exitCode !== 0 || report.errors.length > 0 || !specsOk || actual.unexpected > 0 || actual.flaky > 0 || failed > 0;
  return {
    status: failure ? "FAIL" : !executed || actual.skipped ? "INCOMPLETE" : "PASS",
    reason: failure ? "playwright_failure" : !executed ? "no_executed_tests" : actual.skipped ? "skipped_tests" : "all_tests_passed_without_retries",
    total: tests.length, executed, passed, failed, skipped: actual.skipped, flaky: actual.flaky, scope: SCOPE,
  };
}

export function inspectAppA11yOutput(stdout, exitCode) {
  // 앞뒤 로그에서 JSON처럼 보이는 조각을 추측하지 않는다. 이번 stdout 전체가 단일 JSON이어야 한다.
  try { return inspectAppA11yReport(JSON.parse(stdout), exitCode); }
  catch { return invalid("missing_or_invalid_playwright_json"); }
}

export async function runAppA11y({ repo = ROOT, command = process.execPath, prefix, env = process.env, scratchParent, timeoutMs = 10 * 60_000 } = {}) {
  const directory = join(repo, "apps/web");
  const cli = prefix ?? [createRequire(join(directory, "package.json")).resolve("@playwright/test/cli")];
  // Mac에서는 내장 디스크로 우회하지 않는다. Linux CI는 runner의 임시 디렉터리를 사용한다.
  const parent = scratchParent ?? (process.platform === "darwin" ? "/Volumes/T7/bigdata/tmp" : env.RUNNER_TEMP ?? tmpdir());
  if (!isAbsolute(parent)) throw new Error("접근성 산출물의 절대 경로가 필요합니다.");
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("T7 또는 CI 임시 디렉터리를 확인하세요.");
  const artifacts = await mkdtemp(join(await realpath(parent), "app-a11y-"));
  const childEnv = { ...env, CI: "1", PLAYWRIGHT_OUTPUT_DIR: artifacts };
  // 사용자의 옛 파일 출력 설정을 상속하면 stdout이 비거나 이전 결과를 읽을 수 있다.
  for (const key of ["PLAYWRIGHT_JSON_OUTPUT_FILE", "PLAYWRIGHT_JSON_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_DIR"]) delete childEnv[key];
  const args = [...cli, "test", "--config", "a11y.config.ts", "--reporter=json", "--output", artifacts];
  let stdout = "", exitCode = 0;
  try {
    ({ stdout } = await exec(command, args, { cwd: directory, env: childEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 ** 2, killSignal: "SIGTERM" }));
  } catch (error) {
    stdout = typeof error.stdout === "string" ? error.stdout : "";
    exitCode = Number.isInteger(error.code) && error.code !== 0 ? error.code : 1;
  }
  // 원문 stdout/stderr·스택·환경은 출력하지 않는다. 실패 스크린샷/trace만 독점 경로에 보존한다.
  return { ...inspectAppA11yOutput(stdout, exitCode), artifacts };
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  try {
    if (process.argv.length !== 2) throw new Error("추가 선택 인자는 지원하지 않습니다.");
    const result = await runAppA11y();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "PASS" ? 0 : result.status === "INCOMPLETE" ? 2 : 1;
  } catch {
    console.error("앱 접근성 검증을 시작하지 못했습니다. 의존성·웹 빌드·Chromium·4175 포트·T7/CI 임시 경로를 확인하세요. 환경 값은 출력하지 않습니다.");
    process.exitCode = 1;
  }
}
