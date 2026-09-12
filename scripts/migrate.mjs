#!/usr/bin/env node
// 단순하지만 프로덕션에서 통하는 마이그레이션 러너.
// - infra/migrations/*.sql 을 파일명 순으로 적용
// - schema_migrations 테이블로 적용 이력 추적, 각 파일은 단일 트랜잭션
// - Drizzle/Prisma 대신 raw SQL을 쓰는 이유: pgvector/HNSW/RLS/generated column 등
//   확장 기능을 ORM DSL로 표현하다 잃는 것이 많고, 리뷰 가능한 SQL이 곧 문서이기 때문.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "infra", "migrations");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);

  // macOS가 비HFS 볼륨에 남기는 AppleDouble(._foo.sql) 등 숨김 파일은 제외한다.
  // 실제로 exFAT 외장 드라이브에서 ._0001_init.sql 이 마이그레이션으로 잡혀 실패했다.
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
    .sort();
  const { rows } = await client.query("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    process.stdout.write(`applying ${file} ... `);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log("ok");
    } catch (err) {
      await client.query("rollback");
      console.error(`FAILED\n${err.message}`);
      process.exit(1);
    }
  }
  console.log("migrations up to date");
} finally {
  await client.end();
}
