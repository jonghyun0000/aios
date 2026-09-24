import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 운영 DB를 재사용하지 않는다. 관리자 연결에서도 URL 옵션을 통한 원격/파일 우회를 거부한다.
function localUrl(value, protocols) {
  const url = new URL(value);
  assert(protocols.includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(!url.search && !url.hash, "URL options are not supported");
  return url;
}
assert(process.env.AIOS_CI_INTEGRATION === "1", "Set AIOS_CI_INTEGRATION=1 explicitly");
const adminUrl = localUrl(process.env.CI_DATABASE_URL, ["postgres:", "postgresql:"]);
const redisUrl = localUrl(process.env.CI_REDIS_URL, ["redis:"]);
const modelUrl = localUrl(process.env.CI_OLLAMA_URL, ["http:"]);
const base = await realpath(process.env.CI_ARTIFACT_ROOT);
if (process.platform === "darwin") assert(base.startsWith("/Volumes/T7/"), "Local artifacts must stay on T7");
const dir = await mkdtemp(join(base, "aios-ci-"));
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
const databases = [];
const env = {
  PATH: process.env.PATH, NODE_ENV: "test", TMPDIR: dir,
  REDIS_URL: redisUrl.href, LOCAL_LLM_BASE_URL: `${modelUrl.origin}/v1`,
  LOCAL_LLM_PROTOCOL: "openai", LOCAL_LLM_MODELS: process.env.CI_CHAT_MODEL || "qwen2.5:0.5b",
  LOCAL_EMBED_MODEL: "bge-m3", LOCAL_LLM_CONTEXT: "8192", LOCAL_CHAT_CONCURRENCY: "1",
  LOCAL_EMBED_CONCURRENCY: "1", LOCAL_NO_AUTH: "1",
};
function child(args, extra) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => {
      output = (output + chunk).slice(-200000); process.stdout.write(chunk);
    });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 10 * 60_000);
    proc.on("error", reject);
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
async function database() {
  const name = `aios_ci_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`); databases.push(name);
  const url = new URL(adminUrl); url.pathname = `/${name}`; return url.href;
}
try {
  await admin.connect();
  const sources = join(root, "infra/migrations");
  const files = (await readdir(sources)).filter((f) => f.endsWith(".sql") && !f.startsWith("."));
  const fingerprint = async () => createHash("sha256").update(Buffer.concat(await Promise.all(files.sort().map((f) => readFile(join(sources, f)))))).digest("hex");
  const before = await fingerprint();
  // 실제 러너를 복제하고 마이그레이션 하나만 누락시킨다. 제품 파일과 정상 DB는 건드리지 않는다.
  const mutant = join(dir, "mutant");
  await mkdir(join(mutant, "scripts"), { recursive: true });
  await mkdir(join(mutant, "infra/migrations"), { recursive: true });
  await symlink(join(root, "node_modules"), join(mutant, "node_modules"));
  await copyFile(join(root, "scripts/migrate.mjs"), join(mutant, "scripts/migrate.mjs"));
  assert(files.includes("0005_execution_safety.sql"));
  for (const file of files) if (file !== "0005_execution_safety.sql") await copyFile(join(sources, file), join(mutant, "infra/migrations", file));
  for (const fault of [true, false]) {
    const databaseUrl = await database();
    const runRoot = join(dir, fault ? "fault" : "normal");
    const workspace = join(runRoot, "workspaces", "fixture"); await mkdir(workspace, { recursive: true });
    const extra = { DATABASE_URL: databaseUrl, LOCAL_WORKSPACE_ROOT: workspace, LOCAL_NO_AUTH_ORG_SLUG: `ci-${randomUUID()}` };
    const migration = await child([join(fault ? mutant : root, "scripts/migrate.mjs")], extra);
    assert.equal(migration.code, 0, "migration process failed");
    // CLI의 IPC 소켓은 exFAT에서 지원되지 않는다. 단일 Node 로더로 실행하면 소켓·래퍼가 필요 없다.
    const run = await child(["--import", "./apps/verify/node_modules/tsx/dist/loader.mjs", "apps/verify/src/ci-integration.ts"], extra);
    if (fault) {
      assert.notEqual(run.code, 0, "missing migration incorrectly passed");
      assert.match(run.output, /CI_SCHEMA_MISSING:42P01/);
      console.log("PASS missing migration rejected by integration process");
    } else {
      assert.equal(run.code, 0, "integration failed");
      const summary = run.output.split("\n").find((line) => line.startsWith('{"result":"PASS","model":'));
      assert(summary, "missing completed integration summary");
      const result = JSON.parse(summary);
      assert.equal(result.chat.passed, 3); assert.equal(result.chat.total, 3);
    }
  }
  assert.equal(await fingerprint(), before, "source migrations changed");
  console.log(`PASS migration source fingerprint ${before}`);
} finally {
  // CREATE 성공을 기록한 이번 실행의 DB만 제거한다. FORCE·운영 데이터 초기화는 쓰지 않는다.
  for (const name of databases) await admin.query(`drop database "${name}"`);
  await admin.end();
  await rm(dir, { recursive: true });
}
