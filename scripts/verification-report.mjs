import { randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 디렉터리 생성 전 기존 조상부터 확인한다. 링크 아래에 새 폴더를 만들지 않는다. */
export async function prepareReportDirectory(directory) {
  const path = resolve(directory);
  const parent = dirname(path);
  if (parent !== path) await prepareReportDirectory(parent);
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("검증 보고서 경로는 링크가 아닌 디렉터리여야 합니다.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
  }
  return path;
}

/** 원문 로그·명령·환경은 받더라도 저장하지 않는다. CLI는 고정 T7 디렉터리만 넘긴다. */
export async function writeVerificationReport(directory, evidence) {
  await prepareReportDirectory(directory);
  const path = join(directory, `verify-${Date.now()}-${randomUUID()}.json`);
  const { startedAt, sourceHashBefore, sourceHashAfter, summary, results } = evidence;
  const record = {
    schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), sourceHashBefore, sourceHashAfter,
    summary: { verdict: summary.verdict, exitCode: summary.exitCode, sourceChanged: summary.sourceChanged,
      passed: summary.passed, failed: summary.failed, blocked: summary.blocked, skipped: summary.skipped },
    results: results.map(({ id, status, ms, kind, tests }) => ({ id, status, ...(ms === undefined ? {} : { ms }), ...(kind ? { kind } : {}),
      ...(tests ? { tests: {
        scope: tests.scope, executed: tests.executed, passed: tests.passed, failed: tests.failed, skipped: tests.skipped, todo: tests.todo,
        packages: tests.packages.map(({ name, status, reason, executed, passed, failed, skipped, todo, failedFiles }) => ({ name, status, reason, executed, passed, failed, skipped, todo, ...(failedFiles ? { failedFiles } : {}) })),
        excludedFiles: tests.excludedFiles.map(({ package: name, file, reason }) => ({ package: name, file, reason })),
        nonTestPackages: tests.nonTestPackages.map(({ name, directory, reason }) => ({ name, directory, reason })),
      } } : {}),
    })),
    limitations: ["선택된 단계의 결과만 의미한다. 생략한 단계는 검증하지 않았다.", "정적/대역 시험을 실제 모델·DB·파일 복원 검증으로 대체하지 않는다."],
  };
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return path;
}
