import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STEPS, selectVerificationSteps, summarizeVerification, verificationInputs } from "./verification-policy.mjs";

const catalog = [...DEFAULT_STEPS, "local-ops", "phase7", "phase8", "s2-claude"].map(id => ({ id }));
const exec = promisify(execFile);
const script = fileURLToPath(new URL("./verify-all.mjs", import.meta.url));

test("검증 대상 지문은 코드/설정/시험/앱 템플릿을 포함하고 설명 문서만 제외", () => {
  const paths = ["README.md", "HANDOFF.md", "docs/25-result.md", "apps/api/src/a.ts", "apps/api/src/prompt.md", "scripts/verify-all.mjs", "package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml"];
  assert.deepEqual(verificationInputs(paths.map(path => ({ path }))).map(file => file.path), paths.slice(3));
});

test("인자 없는 검증은 정적 4단계만 선택하고 서비스·파괴 시험을 실행하지 않는다", () => {
  assert.deepEqual(selectVerificationSteps([], catalog).steps.map(step => step.id), DEFAULT_STEPS);
  assert.deepEqual(selectVerificationSteps(["--report"], catalog).steps.map(step => step.id), DEFAULT_STEPS);
});
test("오타·알 수 없는 옵션·중복·잘못된 카탈로그를 조용히 무시하지 않는다", () => {
  for (const args of [["typo"], ["--unknown"], ["build", "build"], ["--legacy-full", "build"], ["--report", "--report"]]) assert.throws(() => selectVerificationSteps(args, catalog));
  assert.throws(() => selectVerificationSteps([], []));
  assert.throws(() => selectVerificationSteps([], [{ id: "build" }, { id: "build" }]));
});
test("파괴 단계는 선택과 별도 명시 플래그가 모두 있어야 한다", () => {
  assert.throws(() => selectVerificationSteps(["phase8"], catalog), /파괴|정리/);
  assert.throws(() => selectVerificationSteps(["--legacy-full"], catalog), /파괴|정리/);
  assert.throws(() => selectVerificationSteps(["--allow-destructive-phase8"], catalog));
  assert.deepEqual(selectVerificationSteps(["phase8", "--allow-destructive-phase8"], catalog).steps, [{ id: "phase8" }]);
  assert.equal(selectVerificationSteps(["--legacy-full", "--allow-destructive-phase8"], catalog).steps.length, catalog.length);
});
test("--list/--help는 단계 실행 없이 안내만 선택한다", () => {
  for (const flag of ["--help", "--list"]) assert.equal(selectVerificationSteps([flag], catalog).steps.length, 0);
  assert.throws(() => selectVerificationSteps(["--list", "build"], catalog));
});
test("0개 검사·전부 SKIP·일부 SKIP/차단은 PASS가 아니다", () => {
  for (const results of [[], [{ status: "SKIP" }], [{ status: "PASS" }, { status: "SKIP" }], [{ status: "BLOCKED" }]]) {
    assert.equal(summarizeVerification(results).verdict, "INCOMPLETE");
    assert.equal(summarizeVerification(results).exitCode, 2);
  }
});
test("실패·잘못된 결과·소스 변경을 구분하고 현재 범위 전체 통과만 PASS", () => {
  assert.equal(summarizeVerification([{ status: "PASS" }]).exitCode, 0);
  assert.equal(summarizeVerification([{ status: "FAIL" }]).exitCode, 1);
  assert.equal(summarizeVerification([{ status: "unknown" }]).verdict, "FAIL");
  assert.equal(summarizeVerification([{ status: "PASS" }], { sourceChanged: true }).verdict, "SOURCE_CHANGED");
  assert.equal(summarizeVerification([{ status: "PASS" }], { sourceChanged: true }).exitCode, 2);
});
test("실제 CLI: 오타와 보호 없는 phase8이 자식 실행 전 exit2로 거부된다", async () => {
  for (const args of [["typo-that-must-not-pass"], ["phase8"], ["--legacy-full"]]) {
    await assert.rejects(exec(process.execPath, [script, ...args], { timeout: 4000 }), error => {
      assert.equal(error.code, 2);
      assert.doesNotMatch(error.stdout, /RUN |VERIFY: PASS/);
      return true;
    });
  }
});
test("실제 CLI: --list는 위험 표시와 단계 목록을 내고 검사를 시작하지 않는다", async () => {
  const { stdout } = await exec(process.execPath, [script, "--list"], { timeout: 4000 });
  assert.match(stdout, /typecheck/); assert.match(stdout, /phase8/); assert.match(stdout, /파괴/);
  assert.doesNotMatch(stdout, /RUN |VERIFY: PASS/);
});

async function cliFixture(t, childSource) {
  const base = existsSync("/Volumes/T7/bigdata/tmp") ? "/Volumes/T7/bigdata/tmp" : await realpath(tmpdir());
  const root = await mkdtemp(join(base, "verification-cli-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  await mkdir(join(root, "scripts"));
  for (const name of ["verify-all.mjs", "verification-policy.mjs", "verification-report.mjs", "verify-vitest.mjs", "package-local.mjs"]) {
    await copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(root, "scripts", name));
  }
  await mkdir(join(root, "apps/api/src"), { recursive: true });
  await writeFile(join(root, "apps/api/src/fixture.ts"), "export const fixture = 1;\n");
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  const child = join(root, "node_modules/.bin/pnpm");
  await writeFile(child, `#!/usr/bin/env node\n${childSource}\n`); await chmod(child, 0o700);
  return join(root, "scripts/verify-all.mjs");
}
test("실제 CLI: 자식 종료0이어도 검사 중 실제 코드 바이트가 바뀌면 PASS를 거부한다", async t => {
  const fixtureScript = await cliFixture(t, "require('node:fs').appendFileSync('apps/api/src/fixture.ts', '// changed during check\\n');");
  await assert.rejects(exec(process.execPath, [fixtureScript, "build"], { timeout: 10_000 }), error => {
    assert.equal(error.code, 2); assert.match(error.stdout, /VERIFY: SOURCE_CHANGED/);
    assert.doesNotMatch(error.stdout, /VERIFY: PASS/); return true;
  });
});
test("실제 CLI: 코드가 그대로인 성공 명령만 PASS이며 격리DB 사전조건 누락은 차단한다", async t => {
  const fixtureScript = await cliFixture(t, "process.exit(0);");
  const { stdout } = await exec(process.execPath, [fixtureScript, "build"], { timeout: 10_000 });
  assert.match(stdout, /VERIFY: PASS — 1 passed/);
  await assert.rejects(exec(process.execPath, [fixtureScript, "durability-local"], {
    timeout: 10_000, env: { ...process.env, AIOS_DURABILITY_TEST: "", DATABASE_URL: "" },
  }), error => { assert.equal(error.code, 2); assert.match(error.stdout, /VERIFY: INCOMPLETE/); assert.doesNotMatch(error.stdout, /RUN /); return true; });
});
