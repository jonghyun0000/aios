import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import ignoreFactory from "ignore";
import type { Pool } from "pg";
import { chunkCode, detectLang, isIndexable } from "./chunker.js";

/**
 * 증분 인덱서.
 *
 * 핵심 아이디어: 파일 단위 content sha 를 DB와 비교해 변경분만 재임베딩한다.
 * 전량 재인덱싱 설계였다면 저장할 때마다 임베딩 비용이 프로젝트 크기에 비례해 발생 —
 * 증분화가 비용 분석(13장)에서 임베딩 항목을 무시 가능한 수준으로 만드는 장치다.
 */

export type EmbedFn = (texts: string[]) => Promise<number[][]>;
export type ProgressFn = (p: { phase: string; done: number; total: number }) => void;

const EMBED_BATCH = 64;
const CONCURRENCY = 4;

export class Indexer {
  constructor(
    private pool: Pool,
    private embed: EmbedFn,
  ) {}

  async indexProject(projectId: string, rootDir: string, onProgress?: ProgressFn, validateFile?: (path: string) => Promise<void>): Promise<{
    added: number;
    updated: number;
    removed: number;
  }> {
    // 1) .gitignore 존중한 파일 수집
    const ig = ignoreFactory();
    ig.add([".git", "node_modules", "dist", "build", ".next", "coverage", "*.lock"]);
    // 권한 검증 실패는 아래의 '없는 .gitignore' 처리로 삼키지 않는다.
    await validateFile?.(join(rootDir, ".gitignore"));
    try {
      ig.add(await readFile(join(rootDir, ".gitignore"), "utf8"));
    } catch {
      /* no .gitignore */
    }

    const files = await walk(rootDir, rootDir, ig);

    // 2) 저장된 sha 로드 → diff 계산
    const { rows: existing } = await this.pool.query<{ id: string; path: string; content_sha: string }>(
      "select id, path, content_sha from code_files where project_id = $1",
      [projectId],
    );
    const existingByPath = new Map(existing.map((r) => [r.path, r]));
    const seen = new Set<string>();

    const toIndex: { path: string; content: string; sha: string }[] = [];
    for (const f of files) {
      await validateFile?.(join(rootDir, f));
      const content = await readFile(join(rootDir, f), "utf8").catch(() => null);
      if (content === null) continue;
      seen.add(f);
      const sha = createHash("sha256").update(content).digest("hex");
      if (existingByPath.get(f)?.content_sha === sha) continue; // unchanged
      toIndex.push({ path: f, content, sha });
    }
    const removed = existing.filter((r) => !seen.has(r.path));

    // 3) 삭제 파일 정리 (chunks는 FK cascade)
    if (removed.length > 0) {
      await this.pool.query("delete from code_files where id = any($1::uuid[])", [removed.map((r) => r.id)]);
    }

    // 4) 변경 파일 처리 — 동시성 제한 (임베딩 API rate limit 보호)
    let done = 0;
    let added = 0;
    let updated = 0;
    const queue = [...toIndex];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const wasUpdate = existingByPath.has(item.path);
        await this.indexFile(projectId, item);
        if (wasUpdate) updated++;
        else added++;
        onProgress?.({ phase: "embedding", done: ++done, total: toIndex.length });
      }
    });
    await Promise.all(workers);

    return { added, updated, removed: removed.length };
  }

  /** 파일 하나 = 트랜잭션 하나. 부분 실패 시 해당 파일만 이전 상태 유지(sha 미갱신 → 재시도 대상). */
  private async indexFile(projectId: string, f: { path: string; content: string; sha: string }): Promise<void> {
    const chunks = chunkCode(f.content);
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      embeddings.push(...(await this.embed(batch.map((c) => c.content))));
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ id: string }>(
        `insert into code_files (project_id, path, content_sha, lang, size_bytes, indexed_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (project_id, path)
         do update set content_sha = $3, lang = $4, size_bytes = $5, indexed_at = now()
         returning id`,
        [projectId, f.path, f.sha, detectLang(f.path), Buffer.byteLength(f.content)],
      );
      const fileId = rows[0]!.id;
      await client.query("delete from code_chunks where file_id = $1", [fileId]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        await client.query(
          `insert into code_chunks (file_id, project_id, start_line, end_line, symbol, content, embedding)
           values ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [fileId, projectId, c.startLine, c.endLine, c.symbol ?? null, c.content, `[${embeddings[i]!.join(",")}]`],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
}

async function walk(root: string, dir: string, ig: ReturnType<typeof ignoreFactory>): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs);
    if (ig.ignores(e.isDirectory() ? `${rel}/` : rel)) continue;
    if (e.isDirectory()) {
      out.push(...(await walk(root, abs, ig)));
    } else if (e.isFile()) {
      const s = await stat(abs).catch(() => null);
      if (s && isIndexable(rel, s.size)) out.push(rel);
    }
  }
  return out;
}
