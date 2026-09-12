#!/usr/bin/env node
// 개발용 시드: Dev 조직 + Dev 사용자 + API 키 발급.
// 키 평문은 이 출력에서 단 한 번만 노출된다 (DB에는 sha256 해시만 저장 — 프로덕션과 동일 규칙).
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: orgRows } = await client.query(
    `insert into organizations (name, slug) values ('Dev Org', 'dev')
     on conflict (slug) do update set name = excluded.name
     returning id`,
  );
  const orgId = orgRows[0].id;

  const { rows: userRows } = await client.query(
    `insert into users (id, email, display_name) values (gen_random_uuid(), 'dev@aios.local', 'Dev')
     on conflict (email) do update set display_name = excluded.display_name
     returning id`,
  );
  const userId = userRows[0].id;

  await client.query(
    `insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')
     on conflict (org_id, user_id) do nothing`,
    [orgId, userId],
  );

  // 재실행 시 이전 dev-key는 폐기하고 새로 발급 (키 로테이션과 동일한 동작)
  await client.query(`delete from api_keys where org_id = $1 and name = 'dev-key'`, [orgId]);
  const secret = `aios_live_${randomBytes(24).toString("base64url")}`;
  await client.query(
    // 개발용 키는 owner 권한. 실제 운영에서는 용도에 맞는 최소 권한으로 발급해야 한다.
    `insert into api_keys (org_id, name, key_hash, key_prefix, scopes, role, created_by)
     values ($1, 'dev-key', $2, $3, '{"*"}', 'owner', $4)`,
    [orgId, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14), userId],
  );

  console.log(JSON.stringify({ orgId, userId, apiKey: secret }, null, 2));
} finally {
  await client.end();
}
