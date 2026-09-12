import type { Pool } from "pg";
import type { CodeChunkHit } from "@aios/shared";

/**
 * 하이브리드 RAG 검색 — 벡터(의미) + 전문검색(어휘)를 RRF로 융합.
 *
 * 코드 검색에서 하이브리드가 필수인 이유: 식별자 완전일치(`getUserById`)는 임베딩 공간에서
 * 흐려지지만 tsvector는 정확히 잡는다. 반대로 "인증 처리하는 곳"은 벡터만 잡는다.
 * RRF(Reciprocal Rank Fusion)를 쓰는 이유: 두 점수 체계(코사인 vs ts_rank)는 스케일이
 * 달라 가중합이 불안정하다. 순위 기반 융합은 스케일 무관·파라미터 하나(k=60)로 견고하다.
 */

import type { EmbedFn } from "./indexer.js";

const RRF_K = 60;

export class CodeRetriever {
  constructor(
    private pool: Pool,
    private embed: EmbedFn,
  ) {}

  async retrieve(projectId: string, query: string, k = 8): Promise<CodeChunkHit[]> {
    const [embedding] = await this.embed([query]);
    const vec = `[${embedding!.join(",")}]`;
    const fetchN = k * 3;

    const [vecRes, lexRes] = await Promise.all([
      this.pool.query<Row>(
        `select c.id, f.path, c.start_line, c.end_line, c.symbol, c.content
           from code_chunks c join code_files f on f.id = c.file_id
          where c.project_id = $1
          order by c.embedding <=> $2::vector
          limit $3`,
        [projectId, vec, fetchN],
      ),
      this.pool.query<Row>(
        `select c.id, f.path, c.start_line, c.end_line, c.symbol, c.content
           from code_chunks c join code_files f on f.id = c.file_id
          where c.project_id = $1 and c.tsv @@ plainto_tsquery('simple', $2)
          order by ts_rank(c.tsv, plainto_tsquery('simple', $2)) desc
          limit $3`,
        [projectId, query, fetchN],
      ),
    ]);

    // RRF 융합
    const scores = new Map<string, { row: Row; score: number }>();
    const accumulate = (rows: Row[]) => {
      rows.forEach((row, rank) => {
        const cur = scores.get(row.id) ?? { row, score: 0 };
        cur.score += 1 / (RRF_K + rank + 1);
        scores.set(row.id, cur);
      });
    };
    accumulate(vecRes.rows);
    accumulate(lexRes.rows);

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ row, score }) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol ?? undefined,
        content: row.content,
        score,
      }));
  }

  /** RAG 청크를 프롬프트 섹션 항목으로 포맷 */
  format(hits: CodeChunkHit[]): string[] {
    return hits.map((h) => `// ${h.path}:${h.startLine}-${h.endLine}${h.symbol ? ` (${h.symbol})` : ""}\n${h.content}`);
  }
}

interface Row {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  content: string;
}
