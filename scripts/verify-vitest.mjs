#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(HERE), "..");
export const PORTABLE_EXCLUSIONS = [
  { file: "src/__tests__/checkpoints.test.ts", reason: "실제 T7 체크포인트 파일 시험: local-ops와 별도 로컬 검증" },
  { file: "src/__tests__/local-operations.test.ts", reason: "실제 T7 운영 기록 fixture: 별도 로컬 검증" },
  { file: "src/__tests__/index-boundary-local.test.ts", reason: "실제 T7 색인 fixture: index-local에서 명시 실행" },
  { file: "src/__tests__/api-ownership-local.test.ts", reason: "독립 프로세스/작업 폴더 소유권: durability-local에서 명시 실행" },
  { file: "src/__tests__/execution-durability-local.test.ts", reason: "격리 Postgres DB/실행 복구: durability-local에서 명시 실행" },
];
const PACKAGES = {
  "@aios/api": "apps/api", "@aios/demo": "apps/demo", "@aios/verify": "apps/verify", "@aios/web": "apps/web",
  "@aios/ai": "packages/ai", "@aios/collab": "packages/collab", "@aios/indexer": "packages/indexer", "@aios/memory": "packages/memory", "@aios/tools": "packages/tools",
};
export const NON_TEST_PACKAGES = {
  "@aios/cli": "apps/cli", "@aios/plugin-host": "packages/plugin-host", "@aios/sdk": "packages/sdk", "@aios/shared": "packages/shared", "aios-vscode": "extensions/vscode",
};
const number = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => ({ status: "FAIL", reason: "invalid_vitest_report", executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0 });

/** Counts assertions, then checks the reporter's aggregate agrees. Never trust success:true alone. */
export function inspectVitestReport(report, exitCode) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults) || typeof report.success !== "boolean") return invalid();
  for (const key of ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites"]) if (!number(report[key])) return invalid();
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const file of report.testResults) {
    if (!file || !["passed", "failed"].includes(file.status) || !Array.isArray(file.assertionResults)) return invalid();
    for (const assertion of file.assertionResults) {
      if (!assertion || !["passed", "failed", "skipped", "pending", "todo", "disabled"].includes(assertion.status)) return invalid();
      const key = ["skipped", "pending", "disabled"].includes(assertion.status) ? "skipped" : assertion.status;
      counts[key]++;
    }
  }
  const executed = counts.passed + counts.failed;
  if (report.numTotalTests !== executed + counts.skipped + counts.todo || report.numPassedTests !== counts.passed || report.numFailedTests !== counts.failed || report.numPendingTests !== counts.skipped || report.numTodoTests !== counts.todo) return invalid();
  const failure = exitCode !== 0 || !report.success || counts.failed > 0 || report.numFailedTestSuites > 0 || report.testResults.some(file => file.status === "failed");
  return { status: failure ? "FAIL" : !executed || counts.skipped || counts.todo ? "INCOMPLETE" : "PASS",
    reason: failure ? "vitest_failure" : !executed ? "no_executed_tests" : counts.skipped || counts.todo ? "unexecuted_tests" : "assertions_passed", executed, ...counts };
}

export function vitestPlan(workspaces, root, mode) {
  if (!["unit", "durability-local", "index-local"].includes(mode) || !Array.isArray(workspaces)) throw new Error("invalid_vitest_selection");
  const known = { ...PACKAGES, ...NON_TEST_PACKAGES };
  const seen = new Set();
  for (const pkg of workspaces) {
    if (resolve(pkg.path ?? "/") === resolve(root)) continue;
    if (typeof pkg.name !== "string" || !known[pkg.name] || seen.has(pkg.name) || resolve(pkg.path) !== resolve(root, known[pkg.name])) throw new Error("unknown_or_duplicate_workspace");
    seen.add(pkg.name);
  }
  if (Object.keys(known).some(name => !seen.has(name))) throw new Error("missing_expected_workspace");
  const names = mode === "unit" ? Object.keys(PACKAGES) : ["@aios/api"];
  return names.map(name => ({ name, directory: PACKAGES[name],
    files: mode === "durability-local" ? ["src/__tests__/api-ownership-local.test.ts", "src/__tests__/execution-durability-local.test.ts"] : mode === "index-local" ? ["src/__tests__/index-boundary-local.test.ts"] : [],
    exclusions: mode === "unit" && name === "@aios/api" ? PORTABLE_EXCLUSIONS : [],
  }));
}

async function hasTestFile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "coverage"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error("linked_non_test_package_input");
    if (entry.isDirectory() ? await hasTestFile(join(directory, entry.name)) : /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return true;
  }
  return false;
}

export function summarizeVitestPackages(packages) {
  const counts = { executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const pkg of packages) for (const key of Object.keys(counts)) counts[key] += pkg[key] ?? 0;
  const status = packages.some(pkg => pkg.status === "FAIL") ? "FAIL" : !packages.length || !counts.executed || packages.some(pkg => pkg.status !== "PASS") ? "INCOMPLETE" : "PASS";
  return { status, ...counts };
}

export async function runVitestPackage({ command, prefix = ["exec", "vitest"], directory, files = [], exclusions = [], reportPath }) {
  // A report path is exclusive to one invocation, so a prior successful JSON cannot be reused.
  if (await lstat(reportPath).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("vitest_report_already_exists");
  for (const file of files) {
    const stat = await lstat(resolve(directory, file)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return { ...invalid(), reason: "selected_test_file_missing" };
  }
  const args = [...prefix, "run", ...files, ...exclusions.flatMap(item => ["--exclude", item.file]), "--reporter=json", `--outputFile=${reportPath}`];
  let exitCode = 0;
  try { await exec(command, args, { cwd: directory, maxBuffer: 2_000_000, timeout: 10 * 60_000 }); }
  catch (error) { exitCode = Number.isInteger(error.code) ? error.code : 1; }
  try {
    const stat = await lstat(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2) throw new Error("invalid_report_file");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const result = inspectVitestReport(report, exitCode);
    if (Array.isArray(report.testResults)) {
      const reported = new Set(report.testResults.filter(file => typeof file.name === "string").map(file => resolve(file.name)));
      if (files.some(file => !reported.has(resolve(directory, file)))) return { ...result, status: "INCOMPLETE", reason: "selected_test_file_not_reported" };
      result.failedFiles = report.testResults.filter(file => file.status === "failed" || file.assertionResults?.some(assertion => assertion.status === "failed")).flatMap(file => {
        if (typeof file.name !== "string") return [];
        const path = relative(directory, file.name);
        return !path || isAbsolute(path) || path.startsWith("..") ? [] : [path];
      });
    }
    return result;
  } catch { return { status: exitCode === 0 ? "INCOMPLETE" : "FAIL", reason: "missing_or_invalid_vitest_report", executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }; }
}

/** Fresh private reports; retain only counts/policy, never assertion text, stack, stdout or env. */
export async function runStructuredVitest({ repo = REPO, pnpm = join(repo, "node_modules/.bin/pnpm"), mode = "unit", scratchParent } = {}) {
  const started = Date.now();
  const root = await realpath(repo);
  const listed = await exec(pnpm, ["-r", "list", "--depth", "-1", "--json"], { cwd: root, maxBuffer: 2_000_000, timeout: 30_000 });
  const plan = vitestPlan(JSON.parse(listed.stdout), root, mode);
  const nonTestPackages = mode === "unit" ? Object.entries(NON_TEST_PACKAGES).map(([name, directory]) => ({ name, directory, reason: "독립 Vitest 시험 없음; PASS에 세지 않음" })) : [];
  for (const pkg of nonTestPackages) if (await hasTestFile(join(root, pkg.directory))) throw new Error("non_test_package_has_tests_update_policy");
  const parent = scratchParent ?? (existsSync("/Volumes/T7/bigdata/tmp") ? "/Volumes/T7/bigdata/tmp" : process.platform === "darwin" ? null : await realpath(tmpdir()));
  if (!parent) throw new Error("T7_required_for_test_reports");
  const scratch = await mkdtemp(join(parent, "vitest-verification-"));
  const rel = relative(parent, scratch);
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error("invalid_scratch_cleanup");
  const packages = [];
  try {
    for (const [index, pkg] of plan.entries()) {
      const reportPath = join(scratch, `package-${index}.json`);
      const result = await runVitestPackage({ command: pnpm, directory: join(root, pkg.directory), files: pkg.files, exclusions: pkg.exclusions, reportPath });
      packages.push({ name: pkg.name, ...result });
    }
  } finally {
    // Only this invocation's exclusive scratch directory is removed; no source/user files.
    await rm(scratch, { recursive: true, force: false });
  }
  const summary = summarizeVitestPackages(packages);
  return { ...summary, ms: Date.now() - started, kind: "vitest", scope: mode === "unit" ? "portable-unit-explicit-exclusions" : mode,
    packages, excludedFiles: mode === "unit" ? PORTABLE_EXCLUSIONS.map(item => ({ ...item, package: "@aios/api" })) : [], nonTestPackages };
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  try {
    const result = await runStructuredVitest({ mode: process.argv[2] ?? "unit" });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
  } catch { console.error("구조화 Vitest 검증을 완료하지 못했습니다. 워크스페이스·보고서·실행 사전조건을 확인하세요."); process.exitCode = 1; }
}
