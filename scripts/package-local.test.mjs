import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allowedFile, createPackage, sourceInventory } from "./package-local.mjs";

const exec = promisify(execFile);
const BASE = "/Volumes/T7/bigdata/tmp";
const ID = "release-20260912T000000Z-1234abcd";
async function removeFixture(path) {
  if ((await lstat(path)).isDirectory()) {
    for (const name of await readdir(path)) await removeFixture(join(path, name));
    await rmdir(path); return;
  }
  // exFAT에서 readdir의 NFD 이름이 unlink에서 ENOENT인 경우가 있어 생성 시 NFC도 확인한다.
  await unlink(path).catch(async error => { if (error.code !== "ENOENT") throw error; await unlink(path.normalize("NFC")); });
}
async function fixture(t) {
  await mkdir(BASE, { recursive: true });
  const root = await mkdtemp(join(BASE, "package-local-test-"));
  t.after(() => removeFixture(root));
  const sourceRoot = join(root, "source"); const releaseRoot = join(root, "releases");
  await mkdir(sourceRoot);
  const put = async (path, text = "fixture\n") => { await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), text); };
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".env.example", "README.md", "HANDOFF.md", "처음 사용하기.md", "apps/api/src/main.ts", "apps/web/src/main.tsx", "infra/migrations/0005_execution_safety.sql", "infra/migrations/0003_api_key_role.sql", "scripts/start-local.sh", "AIOS 사용 패키지 만들기.command"]) await put(path);
  await put("package.json", JSON.stringify({ name: "fixture", version: "1.0.0", packageManager: "pnpm@9.12.0" }));
  return { sourceRoot, releaseRoot, id: ID, put };
}

test("명시 allowlist는 제품 소스·설정·마이그레이션·한글 launcher만 포함한다", () => {
  for (const path of [".dockerignore", "NEXT_STEPS.md", "CHANGELOG.md"]) assert.equal(allowedFile(path), true, path);
  for (const path of ["vercel.json", ".vercelignore", "apps/demo/package.json", "apps/demo/src/App.tsx", "apps/demo/public/favicon.svg", "scripts/doctor.mjs", "apps/web/a11y.config.ts"]) assert.equal(allowedFile(path), true, path);
  for (const path of [".vercel/project.json", ".vercel/.env.production.local", "apps/demo/dist/assets/private.js", "apps/demo/.env.local"]) assert.equal(allowedFile(path), false, path);
  for (const path of [".env.example", ".npmrc", ".gitattributes", "apps/web/src/pages/Chat.tsx", "packages/tools/src/builtin/fs.ts", "packages/tools/scripts/mcp-smoke.ts", "infra/migrations/0003_api_key_role.sql", "AIOS 사용 패키지 만들기.command", "docs/20-stage4.md", ".github/workflows/ci.yml"]) assert.equal(allowedFile(path), true, path);
  for (const path of [".env", ".env.local", "apps/api/src/.env.test", "secrets/key.txt", "apps/api/src/secrets/token.json", "apps/web/dist/index.html", "apps/verify/logs/result.jsonl", "apps/web/test-results/result.json", "node_modules/pg/package.json", ".git/config", "docs/._guide.md", "tools/bigdata/data.parquet", "apps/api/src/database.dump", "private-notes.md", "apps/unknown/src/index.ts"]) assert.equal(allowedFile(path), false, path);
  for (const path of ["../README.md", "/README.md", "apps\\api\\src\\main.ts", "apps/api/../main.ts"]) assert.throws(() => allowedFile(path));
});

test("실제 tar 패키지와 SHA256를 검증하고 비밀·출력은 archive에서 제외한다", async t => {
  const f = await fixture(t);
  for (const path of [".dockerignore", "NEXT_STEPS.md", "CHANGELOG.md"]) await f.put(path);
  for (const path of [".env.local", ".env", "apps/api/src/secrets/token.json", "node_modules/tool/index.js", "apps/web/dist/bundle.js", "apps/verify/logs/private.jsonl", "docs/._private.md"]) await f.put(path, "DO-NOT-PACK-secret-fixture");
  const result = await createPackage(f);
  assert.equal(result.status, "passed");
  const archive = await readFile(result.archive);
  assert.equal(createHash("sha256").update(archive).digest("hex"), result.sha256);
  const checksum = await readFile(result.archive + ".sha256", "utf8");
  assert.ok(checksum.startsWith(result.sha256 + "  "));
  const listed = (await exec("tar", ["-tzf", result.archive])).stdout.split("\n");
  assert.ok(listed.includes("./.env.example"));
  for (const path of [".dockerignore", "NEXT_STEPS.md", "CHANGELOG.md"]) assert.ok(listed.includes(`./${path}`), path);
  assert.ok(listed.includes("./infra/migrations/0003_api_key_role.sql"));
  assert.ok(!listed.some(path => /node_modules|dist\/|secrets\/|\.env\.local|private\.jsonl|\/\._/.test(path)));
  const manifest = JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.archive.sha256, result.sha256);
  assert.equal(manifest.codeHash, result.codeHash);
  assert.equal(manifest.node, process.version);
  assert.match(manifest.scope, /소스 패키지/);
  assert.equal(manifest.sourceFiles.length, result.files);
  assert.equal((await readdir(result.directory)).length, 3);
});

test("기존 릴리스는 덮어쓰지 않고 기존 bytes를 보존한다", async t => {
  const f = await fixture(t); const first = await createPackage(f);
  const before = await readFile(first.archive);
  await assert.rejects(createPackage(f), /덮어쓰지/);
  assert.deepEqual(await readFile(first.archive), before);
});

test("실제 소스 변경을 주입하면 완료 릴리스 대신 .partial만 남긴다", async t => {
  const f = await fixture(t);
  await assert.rejects(createPackage({ ...f, afterSnapshot: () => f.put("README.md", "changed during packaging\n") }), /소스.*변경/);
  assert.deepEqual(await readdir(f.releaseRoot), [ID + ".partial"]);
});

test("소스 경로의 symlink를 주입하면 읽어서 패키징하지 않는다", async t => {
  const f = await fixture(t);
  await symlink("../main.ts", join(f.sourceRoot, "apps/api/src/link.ts"));
  await assert.rejects(sourceInventory(f.sourceRoot), /심볼릭 링크/);
});

test("필수 코드 누락과 npm 인증정보를 성공으로 처리하지 않는다", async t => {
  const f = await fixture(t);
  await f.put(".npmrc", "//registry.example/:_authToken=DO-NOT-PACK-secret-fixture\n");
  await assert.rejects(createPackage(f), /인증 정보/);
  const other = await fixture(t);
  await rm(join(other.sourceRoot, "infra/migrations/0005_execution_safety.sql"));
  await assert.rejects(createPackage(other), /필요한.*빠져/);
});
