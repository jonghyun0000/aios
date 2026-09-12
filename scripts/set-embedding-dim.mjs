#!/usr/bin/env node
/**
 * 임베딩 차원 변경.
 *
 * 왜 마이그레이션 파일이 아니라 별도 스크립트인가:
 * 벡터 차원은 '어떤 임베더를 쓰는가'라는 배포 시점 결정이지 스키마의 고정 사실이 아니다.
 *   - OpenAI text-embedding-3-small → 1536
 *   - bge-m3 (로컬)                 → 1024
 *   - nomic-embed-text (로컬)       → 768
 * 0001 마이그레이션은 1536으로 고정돼 있어, 로컬 임베더로 바꾸면
 * "expected 1536 dimensions, not 1024"로 저장이 실패한다. 실제로 그렇게 됐다.
 *
 * 기존 벡터를 보존하지 않는 이유: 차원이 다른 임베딩은 서로 비교할 수 없다.
 * 남겨두면 코사인 거리가 의미 없는 값을 내놓고, 그것을 검색 결과라고 믿게 된다.
 * 그래서 데이터가 있으면 --force 없이는 거부한다.
 *
 * 사용:
 *   EMBED_DIM=1024 node scripts/set-embedding-dim.mjs          # 비어 있을 때만
 *   EMBED_DIM=1024 node scripts/set-embedding-dim.mjs --force  # 기존 임베딩 폐기
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const dim = Number(process.env.EMBED_DIM);
if (!Number.isInteger(dim) || dim < 64 || dim > 16000) {
  console.error("EMBED_DIM must be an integer between 64 and 16000 (pgvector HNSW limit is 2000)");
  process.exit(1);
}
const force = process.argv.includes("--force");

// (테이블, 벡터컬럼, 인덱스명) — 0001 스키마와 일치해야 한다.
const TARGETS = [
  { table: "memory_items", column: "embedding", index: "memory_items_embedding_idx" },
  { table: "code_chunks", column: "embedding", index: "code_chunks_embedding_idx" },
];

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const current = await client.query(
    `select table_name, atttypmod as dim
       from information_schema.columns c
       join pg_attribute a on a.attrelid = (c.table_schema||'.'||c.table_name)::regclass
                          and a.attname = c.column_name
      where c.table_name = any($1) and c.column_name = 'embedding'`,
    [TARGETS.map((t) => t.table)],
  );
  for (const r of current.rows) console.log(`현재: ${r.table_name}.embedding = vector(${r.dim})`);

  let occupied = 0;
  for (const t of TARGETS) {
    const { rows } = await client.query(
      `select count(*)::int n from ${t.table} where ${t.column} is not null`,
    );
    occupied += rows[0].n;
  }
  if (occupied > 0 && !force) {
    console.error(
      `\n거부: 기존 임베딩 ${occupied.toLocaleString()}행이 있다.\n` +
        "차원이 다른 벡터는 비교 자체가 불가능해 남겨두면 검색이 조용히 틀린 답을 낸다.\n" +
        "폐기하고 재임베딩할 각오가 되면 --force 를 붙여라.",
    );
    process.exit(2);
  }

  await client.query("begin");
  for (const t of TARGETS) {
    // 인덱스를 먼저 지운다. 컬럼 타입을 바꾸면 HNSW 인덱스는 어차피 무효가 된다.
    await client.query(`drop index if exists ${t.index}`);
    // 기존 값은 버린다(위에서 동의를 받았다). null로 비운 뒤 타입을 바꿔야
    // 차원 불일치로 ALTER가 실패하지 않는다.
    if (occupied > 0) await client.query(`update ${t.table} set ${t.column} = null`);
    await client.query(
      `alter table ${t.table} alter column ${t.column} type vector(${dim}) using null`,
    );
    await client.query(
      `create index ${t.index} on ${t.table} using hnsw (${t.column} vector_cosine_ops)`,
    );
    console.log(`변경: ${t.table}.${t.column} → vector(${dim}) (+HNSW 재생성)`);
  }
  await client.query("commit");
  console.log(`\n완료. 임베딩 차원 = ${dim}. 기존 임베딩은 비었으므로 재색인이 필요하다.`);
} catch (err) {
  await client.query("rollback").catch(() => {});
  console.error("실패:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
