import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rmdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";
import { assertNoWorkspaceApi } from "./local-backup.mjs";

const source = await readFile(new URL("../apps/api/src/execution/ownership.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm", target: "node22" });
const { acquireLocalApiOwnership } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("maintenance↔직접 API 시작 실제 경합 12회에서 둘 다 성공하는 경우는 없다", async () => {
  const base = "/Volumes/T7/bigdata/test-artifacts/api-backup-race"; await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")); const workspace = join(root, "workspaces/fixture");
  await mkdir(workspace, { recursive: true }); await mkdir(join(root, "run/local-app"), { recursive: true });
  const maintenance = join(root, "run/local-app/maintenance.lock");
  try {
    for (let iteration = 0; iteration < 12; iteration++) {
      const start = async () => acquireLocalApiOwnership(workspace);
      const backup = async () => { await mkdir(maintenance); await assertNoWorkspaceApi(workspace); return true; };
      const jobs = iteration % 2 ? [start(), backup()] : [backup(), start()];
      const results = await Promise.allSettled(jobs);
      assert.ok(results.filter(item => item.status === "fulfilled").length <= 1, "API와 오프라인 백업이 동시에 허용됨");
      for (const result of results) if (result.status === "fulfilled" && result.value !== true) await result.value.release();
      await rmdir(maintenance);
      await assertNoWorkspaceApi(workspace);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
