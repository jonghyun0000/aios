/**
 * 격리 복원된 DB의 Yjs/벡터와 실제 파일 복구 경로를 검사한다.
 * 운영 DB는 연결조차 하지 않으며, 파일 쓰기는 독점 신규 probe 폴더 안에서만 한다.
 */
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import pg from "pg";
import * as Y from "yjs";
import { AiosError } from "@aios/shared";
import { prepareCheckpoint, restoreCheckpoint } from "../../api/src/execution/checkpoints.js";

class ProbeError extends Error {}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new ProbeError(message); }
let phase = "arguments";

function argumentsFromCli(): { database: string; root: string } {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  assert(args.length === 4, "--database와 --root를 각각 한 번 지정하세요.");
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!; const value = args[i + 1]!;
    assert((name === "--database" || name === "--root") && !options.has(name) && !value.startsWith("--"), "검사 인자가 올바르지 않습니다.");
    options.set(name, value);
  }
  const database = options.get("--database") ?? "";
  const root = options.get("--root") ?? "";
  assert(/^aios_restore_[a-z0-9_]{1,50}$/.test(database), "격리 복원 DB 이름만 사용할 수 있습니다.");
  assert(isAbsolute(root), "복원 폴더는 절대 경로여야 합니다.");
  return { database, root: resolve(root) };
}

async function verifyRoot(root: string, database: string): Promise<void> {
  assert(root === join("/Volumes/T7/bigdata/workspaces/.recovery", database), "검사 폴더는 해당 격리 DB와 같은 이름의 T7 복원 전용 폴더여야 합니다.");
  assert((await realpath(root)).normalize("NFC") === root.normalize("NFC"), "검사 폴더에 심볼릭 링크가 포함되어 있습니다.");
  assert((await lstat(root)).isDirectory(), "복원 검사 폴더가 없습니다.");
}

function restoredDatabaseUrl(database: string): string {
  const raw = process.env.DATABASE_URL;
  assert(raw, "DATABASE_URL 환경 변수가 필요합니다.");
  const url = new URL(raw);
  assert(url.protocol === "postgres:" || url.protocol === "postgresql:", "Postgres 연결 설정이 필요합니다.");
  assert(decodeURIComponent(url.pathname.slice(1)) !== database, "원본 DATABASE_URL의 DB를 검사 대상으로 사용할 수 없습니다.");
  // 사용자/호스트/포트/연결 옵션은 보존하며 DB 이름만 바꾼다. URL은 출력하지 않는다.
  url.pathname = `/${database}`;
  return url.toString();
}

async function verifyCollaboration(client: pg.Client): Promise<number> {
  let documents = 0;
  // 모든 문서를 검사하되, 복원 데이터가 커져도 한 번에 전체 bytea를 메모리에 올리지 않는다.
  await client.query("declare recovery_collab cursor for select state from collab_docs order by org_id, doc_id");
  try {
    for (;;) {
      const batch = await client.query<{ state: Buffer }>("fetch forward 100 from recovery_collab");
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        assert(Buffer.isBuffer(row.state), "협업 문서 상태가 바이너리 형식이 아닙니다.");
        const doc = new Y.Doc(); const roundTrip = new Y.Doc();
        try {
          Y.applyUpdate(doc, row.state);
          Y.applyUpdate(roundTrip, Y.encodeStateAsUpdate(doc));
          assert(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(Y.encodeStateVector(roundTrip))), "협업 문서의 Yjs 재인코딩 결과가 일치하지 않습니다.");
        } finally { doc.destroy(); roundTrip.destroy(); }
        documents++;
      }
    }
  } finally { await client.query("close recovery_collab"); }
  return documents;
}

type VectorCase = { status: "passed"; embeddedRows: number; dimensions: number; selfDistance: number } | { status: "not_present"; embeddedRows: number; reason: "no_embeddings" | "no_nonzero_embeddings" };
async function verifyVectorTable(client: pg.Client, table: "memory_items" | "code_chunks"): Promise<VectorCase> {
  // 테이블명은 고정 union만 사용한다. NULL/영벡터에는 코사인 자기 유사도를 주장하지 않는다.
  const count = await client.query<{ embedded: string }>(`select count(*)::text as embedded from ${table} where embedding is not null`);
  const embeddedRows = Number(count.rows[0]?.embedded);
  assert(Number.isSafeInteger(embeddedRows) && embeddedRows >= 0, "벡터 행 수를 확인할 수 없습니다.");
  if (embeddedRows === 0) return { status: "not_present", embeddedRows, reason: "no_embeddings" };
  const result = await client.query<{ dimensions: number; self_distance: number }>(
    `select vector_dims(embedding) as dimensions, (embedding <=> embedding) as self_distance
       from ${table}
      where embedding is not null and (embedding <=> embedding) < 'Infinity'::float8
      order by id limit 1`,
  );
  const row = result.rows[0];
  if (!row) return { status: "not_present", embeddedRows, reason: "no_nonzero_embeddings" };
  const distance = Number(row.self_distance);
  assert(Number.isInteger(row.dimensions) && row.dimensions > 0 && Number.isFinite(distance) && Math.abs(distance) <= 0.000001, "실제 pgvector 자기 유사도 검사가 실패했습니다.");
  return { status: "passed", embeddedRows, dimensions: row.dimensions, selfDistance: distance };
}

async function verifyCheckpoints(root: string): Promise<3> {
  const probe = await mkdtemp(join(root, "stage4-probe-"));
  try {
    const existing = join(probe, "existing.txt");
    await writeFile(existing, "복원 전 원본\n", { flag: "wx" });
    const before = await prepareCheckpoint(probe, "existing.txt", "승인된 변경\n");
    await writeFile(existing, before.after);
    await restoreCheckpoint(probe, before);
    assert(await readFile(existing, "utf8") === "복원 전 원본\n", "기존 파일 원본 복구 검사가 실패했습니다.");

    const created = await prepareCheckpoint(probe, "created.txt", "새 파일\n");
    assert(created.before === null, "신규 파일 표본이 이미 존재합니다.");
    await writeFile(join(probe, "created.txt"), created.after, { flag: "wx" });
    await restoreCheckpoint(probe, created);
    const removed = await lstat(join(probe, "created.txt")).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return true; throw error; });
    assert(removed, "신규 파일 제거 복구 검사가 실패했습니다.");

    const conflicted = join(probe, "conflict.txt");
    await writeFile(conflicted, "원본\n", { flag: "wx" });
    const conflict = await prepareCheckpoint(probe, "conflict.txt", "승인된 변경\n");
    await writeFile(conflicted, conflict.after);
    // 실제 수동 변경 결함을 주입한다. 단지 예외가 나는 것뿐 아니라 내용을 보존해야 통과다.
    await writeFile(conflicted, "이후 직접 수정한 내용 — 덮어쓰기 금지\n");
    let refused = false;
    try { await restoreCheckpoint(probe, conflict); }
    catch (error) { if (error instanceof AiosError && error.code === "file_conflict") refused = true; else throw error; }
    assert(refused && await readFile(conflicted, "utf8") === "이후 직접 수정한 내용 — 덮어쓰기 금지\n", "수동 변경 충돌 거부·내용 보존 검사가 실패했습니다.");
    return 3;
  } finally {
    // 이 호출이 독점 생성한 표본만 정리한다. 복원된 사용자 파일/폴더는 건드리지 않는다.
    await rm(probe, { recursive: true, force: false });
  }
}

async function main(): Promise<void> {
  const { database, root } = argumentsFromCli();
  await verifyRoot(root, database);
  const connectionString = restoredDatabaseUrl(database);
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, application_name: "aios-stage4-recovery-probe" });
  phase = "database-read-only";
  let connected = false;
  let collaborationDocuments: number;
  let tables: { memory_items: VectorCase; code_chunks: VectorCase };
  try {
    await client.connect(); connected = true;
    await client.query("begin transaction isolation level repeatable read read only");
    const connection = await client.query<{ database: string; read_only: string }>("select current_database() as database, current_setting('transaction_read_only') as read_only");
    assert(connection.rows[0]?.database === database && connection.rows[0].read_only === "on", "격리 DB의 읽기 전용 연결을 확인할 수 없습니다.");
    phase = "collaboration-yjs";
    collaborationDocuments = await verifyCollaboration(client);
    phase = "vector-self-distance";
    tables = { memory_items: await verifyVectorTable(client, "memory_items"), code_chunks: await verifyVectorTable(client, "code_chunks") };
  } finally {
    if (connected) await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
  phase = "checkpoint-restore";
  const checkpointCases = await verifyCheckpoints(root);
  const vector = { status: Object.values(tables).some((table) => table.status === "passed") ? "passed" : "not_present", tables };
  process.stdout.write(`${JSON.stringify({ collaborationDocuments, vector, checkpointCases })}\n`);
}

await main().catch((error: unknown) => {
  // 연결 문자열·DB 내용·Yjs 문서 원문이 예외 메시지에 섞일 수 있어 그대로 출력하지 않는다.
  process.stderr.write(`${JSON.stringify({ error: error instanceof ProbeError ? error.message : "복원 실동작 검사가 실패했습니다.", phase })}\n`);
  process.exitCode = 1;
});
