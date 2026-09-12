import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareReportDirectory, writeVerificationReport } from "./verification-report.mjs";

async function fixture(t) {
  const base = existsSync("/Volumes/T7/bigdata/tmp") ? "/Volumes/T7/bigdata/tmp" : await realpath(tmpdir());
  const root = await mkdtemp(join(base, "verification-report-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  return root;
}
test("보고서 경로의 링크를 먼저 거부해 링크 대상에 폴더도 만들지 않는다", async t => {
  const root = await fixture(t); const outside = join(root, "outside"); await mkdir(outside);
  await symlink(outside, join(root, "link"));
  await assert.rejects(prepareReportDirectory(join(root, "link", "new")), /링크/);
  assert.equal(existsSync(join(outside, "new")), false);
});
test("보고서 경로가 파일이면 기존 파일을 보존하고 거부한다", async t => {
  const root = await fixture(t); const path = join(root, "keep"); await writeFile(path, "original");
  await assert.rejects(prepareReportDirectory(path), /디렉터리/);
  assert.equal(await readFile(path, "utf8"), "original");
});
test("보고서는 고유 파일에 상태·소스지문만 남기고 환경/원문/임의 필드를 제외한다", async t => {
  const root = await fixture(t);
  const evidence = { startedAt: new Date().toISOString(), sourceHashBefore: "a".repeat(64), sourceHashAfter: "a".repeat(64),
    summary: { verdict: "PASS", exitCode: 0, sourceChanged: false, passed: 1, failed: 0, skipped: 0, blocked: 0, raw: "SECRET_FIXTURE" },
    results: [{ id: "build", status: "PASS", ms: 123, env: { API_KEY: "SECRET_FIXTURE" }, tail: ["SECRET_FIXTURE"], cmd: "SECRET_FIXTURE" }], env: "SECRET_FIXTURE" };
  const first = await writeVerificationReport(join(root, "reports"), evidence);
  const second = await writeVerificationReport(join(root, "reports"), evidence);
  assert.notEqual(first, second);
  const body = await readFile(first, "utf8"); assert.doesNotMatch(body, /SECRET_FIXTURE|API_KEY|"env"|"tail"/);
  assert.deepEqual(JSON.parse(body).results, [{ id: "build", status: "PASS", ms: 123 }]);
  assert.equal((await lstat(first)).isFile(), true);
});
