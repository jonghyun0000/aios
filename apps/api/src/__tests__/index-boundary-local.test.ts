import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Indexer } from "@aios/indexer";
import type { Pool } from "pg";
import type { AppContext } from "../context.js";
import { runIndexJob } from "../index-boundary.js";

// 명시적으로 실행한 T7 fixture만 사용한다. Linux CI의 가짜 성공으로 세지 않는다.
it.skipIf(process.env.AIOS_INDEX_FS_TEST !== "1")("실제 T7 일반 파일은 색인하고 인접 폴더는 읽기 전에 거부한다 (DB/임베딩은 대역)", async () => {
  const base = "/Volumes/T7/bigdata/test-workspaces/index-boundary";
  await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(join(base, "case-"));
  const root = join(fixture, "workspace");
  const outside = join(fixture, "outside");
  await mkdir(root); await mkdir(outside);
  const insideFile = join(root, "note.md");
  const outsideFile = join(outside, "note.md");
  await writeFile(insideFile, "INTERNAL_SYNTHETIC_FIXTURE");
  await writeFile(outsideFile, "EXTERNAL_SYNTHETIC_FIXTURE");
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("organizations") ? [{ id: "org" }] : sql.includes("from projects") ? [{ id: "project" }] : [] }));
  const pool = { query, connect: async () => ({ query: async () => ({ rows: [{ id: "file" }] }), release() {} }) } as unknown as Pool;
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [0, 1]));
  const ctx = { env: { LOCAL_WORKSPACE_ROOT: root, LOCAL_NO_AUTH_ORG_SLUG: "local" }, pool, indexer: new Indexer(pool, embed) } as unknown as AppContext;
  try {
    await expect(runIndexJob(ctx, { projectId: "project", orgId: "org", rootDir: outside })).rejects.toMatchObject({ status: 403 });
    expect(embed).not.toHaveBeenCalled();
    await expect(runIndexJob(ctx, { projectId: "project", orgId: "org", rootDir: root })).resolves.toEqual({ added: 1, updated: 0, removed: 0 });
    expect(embed.mock.calls.flat(2)).toEqual(["INTERNAL_SYNTHETIC_FIXTURE"]);
  } finally {
    // 자신이 독점 생성한 합성 fixture의 정확한 파일만 정리한다.
    await unlink(insideFile); await unlink(outsideFile);
    await rmdir(root); await rmdir(outside); await rmdir(fixture);
  }
});
