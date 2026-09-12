import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectVitestReport, NON_TEST_PACKAGES, PORTABLE_EXCLUSIONS, runVitestPackage, summarizeVitestPackages, vitestPlan } from "./verify-vitest.mjs";
import { writeVerificationReport } from "./verification-report.mjs";

function json(statuses, overrides = {}) {
  const count = status => statuses.filter(value => value === status).length;
  return { numTotalTests: statuses.length, numPassedTests: count("passed"), numFailedTests: count("failed"), numPendingTests: count("skipped"), numTodoTests: count("todo"), numFailedTestSuites: count("failed") ? 1 : 0, success: !count("failed"),
    testResults: [{ name: "fixture.test.js", status: count("failed") ? "failed" : "passed", assertionResults: statuses.map(status => ({ status, title: "synthetic-only" })) }], ...overrides };
}
test("success:true and exit0 do not turn zero/all-skipped/todo tests into PASS", () => {
  for (const statuses of [[], ["skipped"], ["todo"], ["passed", "skipped"], ["passed", "todo"]]) {
    assert.equal(inspectVitestReport(json(statuses), 0).status, "INCOMPLETE");
  }
  assert.equal(inspectVitestReport(json(["passed"]), 0).status, "PASS");
});
test("false aggregate, failed suite, invalid JSON schema and nonzero exit fail closed", () => {
  for (const report of [null, {}, json(["passed"], { numTotalTests: 0 }), json(["passed"], { numFailedTestSuites: 1 }), json(["passed"], { success: false }), json(["unknown"])]) assert.equal(inspectVitestReport(report, 0).status, "FAIL");
  assert.equal(inspectVitestReport(json(["passed"]), 1).status, "FAIL");
});
test("all-skipped packages cannot disappear behind another successful package", () => {
  const summary = summarizeVitestPackages([inspectVitestReport(json(["passed"]), 0), inspectVitestReport(json(["skipped"]), 0)]);
  assert.equal(summary.status, "INCOMPLETE"); assert.equal(summary.executed, 1); assert.equal(summary.skipped, 1);
  assert.equal(summarizeVitestPackages([]).status, "INCOMPLETE");
});

const paths = { "@aios/api": "apps/api", "@aios/demo": "apps/demo", "@aios/verify": "apps/verify", "@aios/web": "apps/web", "@aios/ai": "packages/ai", "@aios/collab": "packages/collab", "@aios/indexer": "packages/indexer", "@aios/memory": "packages/memory", "@aios/tools": "packages/tools", ...NON_TEST_PACKAGES };
const workspaces = Object.entries(paths).map(([name, path]) => ({ name, path: join("/synthetic", path) }));
test("portable selection records exact local exclusions, requires expected packages and isolates local modes", () => {
  const plan = vitestPlan(workspaces, "/synthetic", "unit");
  assert.equal(plan.length, 9); assert.equal(plan.find(pkg => pkg.name === "@aios/api").exclusions.length, 5);
  assert.deepEqual(vitestPlan(workspaces, "/synthetic", "index-local")[0].files, ["src/__tests__/index-boundary-local.test.ts"]);
  assert.equal(vitestPlan(workspaces, "/synthetic", "durability-local")[0].files.length, 2);
  assert.throws(() => vitestPlan([], "/synthetic", "unit"));
  assert.throws(() => vitestPlan([...workspaces, workspaces[0]], "/synthetic", "unit"));
  assert.throws(() => vitestPlan([...workspaces, { name: "unknown", path: "/outside" }], "/synthetic", "unit"));
});

async function fixture(t) {
  const parent = existsSync("/Volumes/T7/bigdata/tmp") ? "/Volumes/T7/bigdata/tmp" : await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, "vitest-counts-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: false }));
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(join(directory, "vitest.config.mjs"), "export default { test: { globals: true, exclude: ['**/._*'], cache: false } };\n");
  return directory;
}
const cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
test("actual Vitest mutation: executed PASS → same test skipped → zero files never becomes PASS", async t => {
  const directory = await fixture(t);
  const file = join(directory, "synthetic.test.js");
  await writeFile(file, "test('synthetic assertion', () => expect(2 + 2).toBe(4));\n");
  const run = name => runVitestPackage({ command: process.execPath, prefix: [cli], directory, reportPath: join(directory, name + ".json") });
  const pass = await run("passed"); assert.equal(pass.status, "PASS"); assert.equal(pass.executed, 1);
  const missing = await runVitestPackage({ command: process.execPath, prefix: [cli], directory, files: ["synthetic.test.js", "missing.test.js"], reportPath: join(directory, "not-reused.json") });
  assert.equal(missing.status, "FAIL"); assert.equal(missing.reason, "selected_test_file_missing");
  await writeFile(file, "test.skip('synthetic assertion', () => expect(2 + 2).toBe(4));\n");
  const skip = await run("skipped"); assert.equal(skip.status, "INCOMPLETE"); assert.equal(skip.executed, 0); assert.equal(skip.skipped, 1);
  await rm(file);
  const empty = await run("empty"); assert.notEqual(empty.status, "PASS"); assert.equal(empty.executed, 0);
  await assert.rejects(run("passed"), /already_exists/);
});
test("actual exit0 with no report cannot be a successful verification", async t => {
  const directory = await fixture(t);
  const result = await runVitestPackage({ command: process.execPath, prefix: ["-e", "process.exit(0)", "--"], directory, reportPath: join(directory, "missing.json") });
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.executed, 0);
});
test("final report retains real counts/exclusions but excludes raw assertion/error contents", async t => {
  const directory = await fixture(t); await mkdir(join(directory, "reports"));
  const tests = { scope: "portable-unit-explicit-exclusions", ...summarizeVitestPackages([inspectVitestReport(json(["passed", "skipped"]), 0)]),
    packages: [{ name: "@aios/api", ...inspectVitestReport(json(["passed", "skipped"]), 0), error: "SECRET_SYNTHETIC" }],
    excludedFiles: PORTABLE_EXCLUSIONS.map(item => ({ ...item, package: "@aios/api" })), nonTestPackages: [{ name: "@aios/sdk", directory: "packages/sdk", reason: "no independent Vitest tests" }], raw: "SECRET_SYNTHETIC" };
  const report = await writeVerificationReport(join(directory, "reports"), { startedAt: "synthetic", sourceHashBefore: "a", sourceHashAfter: "a", summary: { verdict: "INCOMPLETE", exitCode: 2 }, results: [{ id: "unit", status: "BLOCKED", kind: "vitest", tests }] });
  const raw = await readFile(report, "utf8"); assert.doesNotMatch(raw, /SECRET_SYNTHETIC/);
  const stored = JSON.parse(raw).results[0].tests;
  assert.equal(stored.executed, 1); assert.equal(stored.skipped, 1); assert.equal(stored.excludedFiles.length, 5); assert.equal(stored.nonTestPackages.length, 1);
});
