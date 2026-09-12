#!/usr/bin/env node
// Offline local backup. Never drops a database or overwrites a recovery target.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = "/Volumes/T7/bigdata";
const RUN = join(DATA, "run/local-app");
const BACKUPS = join(DATA, "backups/local");
const STATUS = join(DATA, "operations/backup-status.json");
const SIGNING_KEY = join(DATA, "secrets/local-backup-signing.key");
const WORKSPACE = join(DATA, "workspaces/my-first-project");
const CHECKPOINTS = join(DATA, "checkpoints/stage3");
const MAX_FILE = 512 * 1024 ** 2;
const MAX_TOTAL = 4 * 1024 ** 3;
const MAX_ENTRIES = 30_000;
const ID = /^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const hash = value => createHash("sha256").update(value).digest("hex");
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const exists = async path => lstat(path).then(() => true).catch(e => { if (e.code === "ENOENT") return false; throw e; });

export function safeRelative(path) {
  if (typeof path !== "string" || path.length > 1024 || path.includes("\\") || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.split("/").some(p => !p || p === "." || p === ".." || p.startsWith("._")) || path.startsWith("/")) {
    throw new Error("안전하지 않은 백업 상대 경로입니다.");
  }
  return path;
}

export async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("심볼릭 링크 경로는 백업·복원에 사용할 수 없습니다.");
    if (current === dirname(current)) break;
    current = dirname(current);
  }
}

export async function digestFile(path) {
  await noLinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE) throw new Error("일반 단일 링크 파일(최대 512 MiB)만 지원합니다.");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_FILE) throw new Error("파일 크기 제한 초과");
      digest.update(chunk);
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error("백업 중 파일이 변경됐습니다.");
    return { size, sha256: digest.digest("hex") };
  } finally { await file.close(); }
}

export async function inventory(root) {
  await noLinks(root);
  if (!(await lstat(root)).isDirectory()) throw new Error("백업 원본은 디렉터리여야 합니다.");
  const entries = []; const names = new Set(); let total = 0;
  async function walk(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      if (name.startsWith("._")) continue; // macOS resource forks are not application state.
      const path = safeRelative(prefix + name);
      const key = path.normalize("NFC").toLowerCase();
      if (names.has(key)) throw new Error("중복 정규화 경로입니다.");
      names.add(key);
      if (names.size > MAX_ENTRIES) throw new Error("백업 파일 개수 제한 초과");
      const absolute = join(dir, name); const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        entries.push({ path, kind: "directory" }); await walk(absolute, path + "/");
      } else if (stat.isFile()) {
        const digest = await digestFile(absolute); total += digest.size;
        if (total > MAX_TOTAL) throw new Error("백업 크기 제한(4 GiB) 초과");
        entries.push({ path, kind: "file", ...digest, mode: stat.mode & 0o777 });
      } else throw new Error("백업은 링크·장치·소켓을 포함할 수 없습니다.");
    }
  }
  await walk(root, "");
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error("백업 목록이 잘못됐습니다.");
  const names = new Map(); let bytes = 0;
  for (const item of entries) {
    safeRelative(item.path);
    const name = item.path.normalize("NFC").toLowerCase();
    if (names.has(name)) throw new Error("중복 백업 경로입니다.");
    if (item.kind !== "file" && item.kind !== "directory") throw new Error("잘못된 파일 종류입니다.");
    if (item.kind === "file") {
      if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !SHA.test(item.sha256)
        || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error("파일 메타데이터 오류");
      bytes += item.size;
    }
    names.set(name, item.kind);
  }
  if (bytes > MAX_TOTAL) throw new Error("백업 크기 제한 초과");
  for (const [path] of names) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (names.get(parent) !== "directory") throw new Error("부모 디렉터리가 없는 백업입니다.");
      parent = dirname(parent);
    }
  }
  return bytes;
}

export async function copyTree(source, target, entries) {
  validateEntries(entries);
  await noLinks(source); await noLinks(dirname(target));
  await mkdir(target, { mode: 0o700 }); // exclusive: an existing target always fails.
  for (const entry of [...entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
    const to = join(target, entry.path); const from = join(source, entry.path);
    if (entry.kind === "directory") { await mkdir(to, { mode: 0o700 }); continue; }
    await noLinks(from); await noLinks(dirname(to));
    const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size) throw new Error("복사 원본이 바뀌었습니다.");
      const output = await open(to, "wx", entry.mode & 0o700 | 0o600);
      try {
        const digest = createHash("sha256"); let size = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > entry.size) throw new Error("복사 중 크기가 변경됐습니다.");
          digest.update(chunk); await output.writeFile(chunk);
        }
        if (size !== entry.size || digest.digest("hex") !== entry.sha256) throw new Error("복사 무결성 불일치");
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
  }
}

async function writeJSON(path, data, exclusive = false) {
  await noLinks(dirname(path));
  const temp = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temp, path);
}

async function readJSON(path, max = 4 * 1024 ** 2) {
  await noLinks(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error("JSON 파일 형식·크기 오류");
  return JSON.parse(await readFile(path, "utf8"));
}

async function maintenance(purpose, work) {
  await mkdir(RUN, { recursive: true }); await noLinks(RUN);
  const path = join(RUN, "maintenance.lock");
  try { await mkdir(path); } catch (e) { if (e.code === "EEXIST") throw new Error("다른 유지보수 작업 또는 미완료 잠금이 있습니다. 상태 확인 후 처리해 주세요."); throw e; }
  const instanceId = randomUUID();
  let release = true;
  try {
    await writeJSON(join(path, "owner.json"), { pid: process.pid, instanceId, createdAt: new Date().toISOString(), projectRoot: REPO, purpose }, true);
    return await work();
  } catch (error) {
    if (error.keepMaintenance) release = false;
    throw error;
  } finally {
    const owner = await readJSON(join(path, "owner.json")).catch(() => null);
    if (release && owner?.instanceId === instanceId) { await unlink(join(path, "owner.json")); await rmdir(path); }
  }
}

export async function assertNoWorkspaceApi(workspaceRoot = WORKSPACE) {
  // 시작기가 관리하지 않는 포트·다른 DB의 직접 API도 같은 파일을 바꿀 수 있다.
  // maintenance를 잡은 뒤 실제 workspace 소유권을 확인한다. 죽었거나 깨진 잠금도 백업이 임의 회수하지 않는다.
  const workspace = (await realpath(workspaceRoot)).normalize("NFC");
  const path = join(dirname(dirname(workspace)), "run/local-api", `${hash(workspace)}.lock`);
  let parent = dirname(path);
  while (!await exists(parent) && parent !== dirname(parent)) parent = dirname(parent);
  await noLinks(parent);
  if (await exists(path) || await exists(`${path}.recovery`)) throw new Error("작업 폴더 API 소유권 잠금이 남아 있습니다. 기존 API를 정상 종료하세요. 깨진 잠금은 docs/26-durable-execution.md에 따라 확인하며 자동 삭제하지 않습니다.");
}

export async function assertQuiescent(client, runRoot = RUN, workspaceRoot = WORKSPACE) {
  await assertNoWorkspaceApi(workspaceRoot);
  for (const entry of await readdir(runRoot, { withFileTypes: true })) {
    if (/^port-.*\.lock$/.test(entry.name)) throw new Error("앱이 실행 중이거나 시작 잠금이 남아 있습니다. AIOS 종료.command를 먼저 실행하세요.");
    if (entry.isDirectory() && entry.name !== "maintenance.lock") {
      const stateFile = join(runRoot, entry.name, "runtime.json");
      if (await exists(stateFile)) {
        const state = await readJSON(stateFile);
        if (["starting", "ready", "stopping"].includes(state.state)) throw new Error("앱이 실행 중이거나 종료 중입니다. AIOS 종료.command로 정상 종료한 뒤 백업하세요.");
        if (state.state !== "stopped") throw new Error("앱의 정상 종료를 확인할 수 없습니다. 시작 후 정상 종료하고 다시 백업하세요.");
      }
    }
  }
  for (const port of [8791, 8790, 8787]) {
    const result = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).then(r => r.stdout).catch(e => { if (e.code === 1) return ""; throw e; });
    if (result.trim()) throw new Error("로컬 API 포트가 사용 중입니다. 앱을 종료한 뒤 다시 시도하세요.");
  }
  const { rows } = await client.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend'");
  if (rows[0].n) throw new Error("다른 DB 연결이 있어 일관된 백업을 보장할 수 없습니다. 개발 서버·DB 도구를 종료하세요.");
}

async function configuration() {
  const env = { ...parseEnv(await readFile(join(REPO, ".env.local"), "utf8")), ...process.env };
  const url = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
    || (url.port || "5432") !== "5432" || !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) || !/^[a-zA-Z0-9_]+$/.test(url.username)) throw new Error("이 도구는 로컬 Compose PostgreSQL(5432)만 지원합니다.");
  const { stdout } = await exec("docker-compose", ["-p", "1ai", "ps", "-q", "postgres"], { cwd: REPO });
  const container = stdout.trim();
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error("PostgreSQL이 꺼져 있습니다. AIOS를 한 번 시작 후 종료하세요.");
  const inspection = JSON.parse((await exec("docker", ["inspect", container])).stdout)[0];
  if (!inspection.State.Running || !inspection.NetworkSettings.Ports["5432/tcp"]?.some(p => p.HostPort === "5432")) throw new Error("로컬 PostgreSQL 포트 연결이 일치하지 않습니다.");
  return { env, url, container, user: decodeURIComponent(url.username), database: url.pathname.slice(1) };
}

async function connect(config, database = config.database) {
  const url = new URL(config.url); url.pathname = "/" + database;
  const client = new pg.Client({ connectionString: url.href, application_name: "aios-local-recovery", connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("set timezone='UTC'; set statement_timeout='120s'; set lock_timeout='5s'");
    return client;
  } catch (error) { await client.end().catch(() => {}); throw error; }
}

async function assertDatabaseIdentity(config, client) {
  const a = (await client.query("select system_identifier::text as id from pg_control_system()")).rows[0].id;
  const b = (await exec("docker", ["exec", config.container, "psql", "-X", "-U", config.user, "-d", config.database, "-Atc", "select system_identifier::text from pg_control_system()"])).stdout.trim();
  if (a !== b) throw new Error("호스트 DB와 백업 컨테이너가 다른 인스턴스입니다.");
}

async function tableNames(client) {
  return (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.tablename);
}

export async function databaseDigest(client) {
  const tables = [];
  for (const name of await tableNames(client)) {
    const { rows } = await client.query(`select encode(digest(row_to_json(t)::text,'sha256'),'hex') as h from public.${quote(name)} t order by h limit 1000001`);
    if (rows.length > 1_000_000) throw new Error("테이블 검증 한도(100만 행)를 초과했습니다.");
    tables.push({ name, rows: rows.length, sha256: hash(rows.map(row => row.h).join("\n")) });
  }
  const sequences = [];
  for (const { sequencename: name } of (await client.query("select sequencename from pg_sequences where schemaname='public' order by sequencename")).rows) {
    const { rows } = await client.query(`select last_value::text, is_called from public.${quote(name)}`);
    sequences.push({ name, ...rows[0] });
  }
  return { tables, sequences };
}

export async function checkpointIntegrity(client, workspaceRoot, store) {
  const { rows } = await client.query(`select a.id,a.arguments,a.before_hash,a.after_hash from execution_actions a join execution_runs r on r.id=a.run_id where a.checkpoint and r.workspace_root=$1 order by a.id`, [workspaceRoot]);
  for (const row of rows) {
    if (!UUID.test(row.id)) throw new Error("체크포인트 ID 오류");
    const cp = await readJSON(join(store, `${row.id}.json`), 1024 ** 2);
    if (typeof cp.path !== "string" || typeof cp.after !== "string" || (cp.before !== null && typeof cp.before !== "string")) throw new Error("체크포인트 형식 오류");
    const target = resolve(workspaceRoot, cp.path); const rel = relative(workspaceRoot, target);
    if (!rel || rel.startsWith(".." + sep) || rel === ".." || resolve(target) === sep) throw new Error("체크포인트 작업 폴더 범위 오류");
    safeRelative(rel.split(sep).join("/"));
    if (cp.path !== row.arguments.path || hash(cp.after) !== cp.afterHash || cp.afterHash !== row.after_hash
      || cp.beforeHash !== row.before_hash || (cp.before === null ? cp.beforeHash !== null : hash(Buffer.from(cp.before, "base64")) !== cp.beforeHash)) throw new Error("DB와 체크포인트 내용이 일치하지 않습니다.");
  }
  const other = (await client.query("select count(*)::int as n from execution_runs where workspace_root<>$1", [workspaceRoot])).rows[0].n;
  return { checked: rows.length, otherWorkspaceRuns: other };
}

async function dockerFile(config, args, path, direction) {
  const file = await open(path, direction === "out" ? "wx" : "r", 0o600);
  try {
    await new Promise((done, reject) => {
      const child = spawn("docker", ["exec", ...(direction === "in" ? ["-i"] : []), "-e", `PGAPPNAME=aios-backup-${randomUUID()}`, "-e", "PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000", config.container, ...args], {
        stdio: direction === "out" ? ["ignore", file.fd, "pipe"] : [file.fd, "ignore", "pipe"],
      });
      child.stderr.resume(); // Never echo connection details or database contents.
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(Object.assign(new Error("PostgreSQL 백업/복원 시간 초과. DB 작업 종료가 불확실해 유지보수 잠금을 보존했습니다. 상태와 DB 연결을 확인해 주세요."), { keepMaintenance: true }));
      }, 180_000);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0) done();
        else reject(Object.assign(new Error(`${args[0]} 실패 (exit ${code}). DB 작업 종료 확인을 위해 유지보수 잠금을 보존했습니다.`), { keepMaintenance: true }));
      });
    });
    if (direction === "out") await file.sync();
  } finally { await file.close(); }
}

async function updateStatus(change) {
  await mkdir(dirname(STATUS), { recursive: true });
  let before;
  try { before = await readJSON(STATUS); } catch { before = { version: 1 }; }
  await writeJSON(STATUS, { version: 1, ...(before?.lastBackup ? { lastBackup: before.lastBackup } : {}),
    ...(before?.lastRestoreCheck ? { lastRestoreCheck: before.lastRestoreCheck } : {}), ...change });
}

export function signManifest(manifest, key) {
  const unsigned = { ...manifest }; delete unsigned.signature;
  return createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex");
}

async function signingKey(create = false) {
  if (create && !await exists(SIGNING_KEY)) {
    await mkdir(dirname(SIGNING_KEY), { recursive: true }); await noLinks(dirname(SIGNING_KEY));
    const handle = await open(SIGNING_KEY, "wx", 0o600);
    try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
  }
  await noLinks(SIGNING_KEY);
  const stat = await lstat(SIGNING_KEY);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32) throw new Error("백업 서명 키가 없거나 손상됐습니다. 원래 키를 보존·복구해 주세요.");
  return readFile(SIGNING_KEY);
}

export async function verifyBundle(dir, key) {
  await noLinks(dir);
  const manifest = await readJSON(join(dir, "manifest.json"));
  if (manifest.version !== 1 || !ID.test(manifest.id) || manifest.id !== dir.split(sep).pop()
    || manifest.scope?.workspaceRoot !== WORKSPACE || manifest.scope?.checkpointRoot !== CHECKPOINTS
    || !Array.isArray(manifest.database?.tables) || !Array.isArray(manifest.database?.sequences)
    || !Number.isInteger(manifest.checkpoints?.checked) || manifest.checkpoints.checked < 0
    || !Number.isInteger(manifest.checkpoints?.otherWorkspaceRuns) || manifest.checkpoints.otherWorkspaceRuns < 0
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !SHA.test(manifest.signature)) throw new Error("지원하지 않는 백업 manifest입니다.");
  const expected = signManifest(manifest, key ?? await signingKey());
  if (!timingSafeEqual(Buffer.from(manifest.signature, "hex"), Buffer.from(expected, "hex"))) throw new Error("백업 서명이 일치하지 않습니다. 이 설치에서 생성한 신뢰된 백업만 복원할 수 있습니다.");
  const bytes = validateEntries(manifest.files);
  if (bytes !== manifest.bytes || bytes <= 0) throw new Error("백업 전체 크기가 일치하지 않습니다.");
  for (const [path, kind] of [["database.dump", "file"], ["workspace", "directory"], ["checkpoints", "directory"]]) {
    if (!manifest.files.some(f => f.path === path && f.kind === kind && (kind !== "file" || f.size > 0))) throw new Error("필수 백업 구성요소가 없습니다.");
  }
  const tables = manifest.database.tables;
  if (new Set(tables.map(t => t.name)).size !== tables.length || tables.some(t => typeof t.name !== "string" || !Number.isSafeInteger(t.rows) || t.rows < 0 || !SHA.test(t.sha256))) throw new Error("DB 검증 메타데이터 오류");
  for (const name of ["organizations", "sessions", "messages", "workspace_files", "collab_docs", "memory_items", "code_chunks", "execution_runs", "execution_actions", "schema_migrations"]) {
    if (!tables.some(t => t.name === name)) throw new Error("필수 DB 테이블이 없습니다.");
  }
  if (manifest.database.sequences.some(s => typeof s.name !== "string" || !/^-?\d+$/.test(s.last_value) || typeof s.is_called !== "boolean")) throw new Error("DB 시퀀스 메타데이터 오류");
  const actual = (await inventory(dir)).filter(e => e.path !== "manifest.json");
  // File permission bits are not meaningful ACLs on exFAT; content and paths are authoritative.
  const canonical = entries => entries.map(({ mode: _mode, ...entry }) => entry);
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(manifest.files))) throw new Error("백업 파일이 누락·추가·변경됐습니다.");
  return manifest;
}

async function backup(config) {
  return maintenance("backup", async () => {
    const client = await connect(config);
    try {
      await assertQuiescent(client); await assertDatabaseIdentity(config, client);
      const tables = await tableNames(client);
      if (!tables.includes("execution_actions")) throw new Error("3단계까지 마이그레이션된 DB가 필요합니다.");
      // Discover names before BEGIN: a catalog SELECT inside repeatable-read would
      // establish a snapshot before locks have waited for an earlier writer.
      await client.query("begin isolation level repeatable read");
      await client.query(`lock table ${tables.map(t => "public." + quote(t)).join(",")} in share mode`);
      const snapshot = (await client.query("select pg_export_snapshot() as id")).rows[0].id;
      const key = await signingKey(true);
      const id = `backup-${stamp()}-${randomUUID().slice(0, 8)}`;
      await mkdir(BACKUPS, { recursive: true }); await noLinks(BACKUPS);
      const partial = join(BACKUPS, `${id}.partial`); await mkdir(partial);
      const checkpointSummary = await checkpointIntegrity(client, WORKSPACE, CHECKPOINTS);
      const workspace = await inventory(WORKSPACE);
      // A fresh installation has no checkpoint directory until its first approved write.
      const hadCheckpointStore = await exists(CHECKPOINTS);
      const checkpoints = hadCheckpointStore ? await inventory(CHECKPOINTS) : [];
      const database = await databaseDigest(client);
      await dockerFile(config, ["pg_dump", "-U", config.user, "-d", config.database, "--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`], join(partial, "database.dump"), "out");
      await copyTree(WORKSPACE, join(partial, "workspace"), workspace);
      if (hadCheckpointStore) await copyTree(CHECKPOINTS, join(partial, "checkpoints"), checkpoints);
      else await mkdir(join(partial, "checkpoints"));
      if (JSON.stringify(workspace) !== JSON.stringify(await inventory(WORKSPACE))
        || JSON.stringify(checkpoints) !== JSON.stringify(await exists(CHECKPOINTS) ? await inventory(CHECKPOINTS) : [])) throw new Error("백업 중 원본 파일이 바뀌었습니다. 결과를 사용하지 마세요.");
      await assertQuiescent(client);
      if (JSON.stringify(database) !== JSON.stringify(await databaseDigest(client))) throw new Error("백업 중 DB 시퀀스 또는 내용이 변경됐습니다.");
      const files = await inventory(partial); const bytes = validateEntries(files);
      const manifest = {
        version: 1, id, createdAt: new Date().toISOString(), bytes, files, database, checkpoints: checkpointSummary,
        scope: { database: config.database, workspaceRoot: WORKSPACE, checkpointRoot: CHECKPOINTS },
        excluded: [".env.local 및 API 키", "Redis 캐시·대기 작업(색인/기억 추출 재요청 필요)", "Ollama 모델·DuckDB·Parquet", "다른 workspace_root의 작업 파일·체크포인트", "macOS ._* 메타데이터"],
      };
      manifest.signature = signManifest(manifest, key);
      await writeJSON(join(partial, "manifest.json"), manifest, true);
      await client.query("commit");
      const dest = join(BACKUPS, id);
      if (await exists(dest)) throw new Error("백업 ID 충돌");
      await rename(partial, dest); await verifyBundle(dest);
      await updateStatus({ lastBackup: { id, createdAt: manifest.createdAt, bytes, manifestPath: join(dest, "manifest.json") } });
      return { operation: "backup", status: "passed", id, path: dest, bytes, files: files.filter(f => f.kind === "file").length, checkpoints: checkpointSummary };
    } finally { await client.query("rollback").catch(() => {}); await client.end(); }
  });
}

async function selectBackup(id) {
  if (id) { if (!ID.test(id)) throw new Error("백업 ID 형식 오류"); return join(BACKUPS, id); }
  const ids = (await readdir(BACKUPS)).filter(n => ID.test(n)).sort();
  if (!ids.length) throw new Error("완료된 통합 백업이 없습니다. 백업부터 실행하세요.");
  return join(BACKUPS, ids.at(-1));
}

async function restoreCheck(config, dir) {
  return maintenance("restore-check", async () => {
    const manifest = await verifyBundle(dir);
    const source = await connect(config); let restored; let clientsClosed = false;
    const database = `aios_restore_${stamp().toLowerCase()}_${randomUUID().slice(0, 8)}`;
    let root;
    try {
      await assertQuiescent(source); await assertDatabaseIdentity(config, source);
      const sourceBefore = await databaseDigest(source);
      const parent = join(DATA, "workspaces/.recovery"); await mkdir(parent, { recursive: true }); await noLinks(parent);
      root = join(parent, database); await mkdir(root); // never reused; failures retained for diagnosis.
      await mkdir(join(root, "workspaces"));
      const tree = prefix => manifest.files.filter(f => f.path.startsWith(prefix + "/")).map(f => ({ ...f, path: f.path.slice(prefix.length + 1) }));
      await copyTree(join(dir, "workspace"), join(root, "workspaces/my-first-project"), tree("workspace"));
      await mkdir(join(root, "checkpoints"));
      await copyTree(join(dir, "checkpoints"), join(root, "checkpoints/stage3"), tree("checkpoints"));
      await copyTree(dir, join(root, "restore-input"), manifest.files.filter(f => f.path === "database.dump"));
      await source.query(`create database ${quote(database)} template template0`);
      await dockerFile(config, ["pg_restore", "-U", config.user, "-d", database, "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"], join(root, "restore-input/database.dump"), "in");
      restored = await connect(config, database);
      const actual = await databaseDigest(restored);
      if (JSON.stringify(actual) !== JSON.stringify(manifest.database)) throw new Error("복원 DB의 행 내용·시퀀스 검증 실패");
      const checkpoints = await checkpointIntegrity(restored, WORKSPACE, join(root, "checkpoints/stage3"));
      if (JSON.stringify(checkpoints) !== JSON.stringify(manifest.checkpoints)) throw new Error("복원 체크포인트 개수 불일치");
      const { stdout } = await exec(join(REPO, "apps/verify/node_modules/.bin/tsx"), [join(REPO, "apps/verify/src/stage4-recovery-probe.ts"), "--database", database, "--root", root], {
        cwd: REPO, env: { ...config.env, DATABASE_URL: config.url.href }, timeout: 60_000, maxBuffer: 1024 ** 2,
      });
      const probe = JSON.parse(stdout.trim());
      if (probe.checkpointCases !== 3 || !Number.isInteger(probe.collaborationDocuments)) throw new Error("복원 동작 검증 결과 형식 오류");
      // Verify again after the drill; the probe must never mutate restored user data or the source.
      if (JSON.stringify(await databaseDigest(restored)) !== JSON.stringify(actual)
        || JSON.stringify(await databaseDigest(source)) !== JSON.stringify(sourceBefore)) throw new Error("복원 검사 중 DB 원본이 변경됐습니다.");
      const report = { version: 1, backupId: manifest.id, checkedAt: new Date().toISOString(), status: "passed", restoredDatabase: database,
        root, files: manifest.files.filter(f => f.kind === "file").length, tables: actual.tables.length, checkpoints, probe,
        activated: false, note: "격리 복원본입니다. 기존 DB/폴더는 교체하지 않았습니다. 원래 절대경로 메타데이터를 유지하며 자동 실행하지 않습니다." };
      await writeJSON(join(root, "restore-report.json"), report, true);
      await verifyBundle(dir);
      await closeRestoreClients([restored, source], manifest.id); clientsClosed = true;
      await updateStatus({ lastRestoreCheck: { backupId: manifest.id, checkedAt: report.checkedAt, status: "passed", restoredDatabase: database, files: report.files } });
      return report;
    } catch (e) {
      await updateStatus({ lastRestoreCheck: { backupId: manifest.id, checkedAt: new Date().toISOString(), status: "failed" } });
      throw Object.assign(new Error(`복원 검사 실패. 원본은 교체하지 않았습니다. 검사 대상: ${database}${root ? ` / ${root}` : ""}. ${e.message}`), { keepMaintenance: e.keepMaintenance });
    } finally {
      if (!clientsClosed) await closeRestoreClients([restored, source], manifest.id);
    }
  });
}

async function closeRestoreClients(clients, backupId) {
  const closed = await Promise.allSettled(clients.filter(Boolean).map(client => client.end()));
  if (closed.some(result => result.status === "rejected")) {
    await updateStatus({ lastRestoreCheck: { backupId, checkedAt: new Date().toISOString(), status: "failed" } });
    throw Object.assign(new Error("복원 검사 DB 연결 정리 실패. 유지보수 잠금을 보존했습니다."), { keepMaintenance: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, id, ...extra] = argv;
  if (!["backup", "verify", "restore-check"].includes(command) || extra.length || (command === "backup" && id)) throw new Error("사용법: node scripts/local-backup.mjs backup | verify [백업ID] | restore-check [백업ID]");
  if (command === "verify") { const dir = await selectBackup(id); const manifest = await verifyBundle(dir); return { status: "passed", id: manifest.id, bytes: manifest.bytes }; }
  const config = await configuration();
  return command === "backup" ? backup(config) : restoreCheck(config, await selectBackup(id));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // realpath also catches running a symlinked checkout before any operational writes.
  try {
    if ((await realpath(REPO)).normalize("NFC") !== REPO.normalize("NFC")) throw new Error("심볼릭 링크 프로젝트에서는 실행할 수 없습니다.");
    process.env.PATH = `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;
    console.log(JSON.stringify(await main(), null, 2));
  } catch (e) {
    console.error("실패:", String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DB 연결 정보 숨김]"));
    process.exitCode = 1;
  }
}
