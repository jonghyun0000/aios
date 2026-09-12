import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { copyTree, hash, inventory, noLinks, safeRelative, signManifest, validateEntries, verifyBundle, checkpointIntegrity, assertQuiescent } from "./local-backup.mjs";

const BASE = "/Volumes/T7/bigdata/test-artifacts/stage4-backup";
await mkdir(BASE, { recursive: true });
const temp = () => mkdtemp(join(BASE, "case-"));
const entry = path => ({ path, kind: "file", size: 3, mode: 0o600, sha256: hash("abc") });

test("manifest path injection rejects traversal, absolute, backslash, empty segments, control characters", () => {
  for (const path of ["../secret", "/secret", "a/../b", "a\\b", "a//b", "./b", "a\n.txt", "._metadata", ""]) assert.throws(() => safeRelative(path));
  assert.equal(safeRelative("한글 폴더/file.txt"), "한글 폴더/file.txt");
});

test("normalized duplicate, orphan parent and oversized/invalid manifests are rejected", () => {
  assert.throws(() => validateEntries([entry("A"), entry("a")]));
  assert.throws(() => validateEntries([entry("가"), entry("가".normalize("NFD"))]));
  assert.throws(() => validateEntries([entry("a/file")]));
  assert.throws(() => validateEntries([{ ...entry("x"), size: 1024 ** 3 }]));
  assert.throws(() => validateEntries([{ ...entry("x"), sha256: "invalid" }]));
  assert.throws(() => validateEntries([{ path: "x", kind: "symlink" }]));
});

test("real source content corruption is detected and existing restore target is never overwritten", async () => {
  const root = await temp(); const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "hello.txt"), "abc"); await mkdir(join(source, "empty"));
  const items = await inventory(source);
  const target = join(root, "restored"); await copyTree(source, target, items);
  assert.equal(await readFile(join(target, "hello.txt"), "utf8"), "abc");
  assert.equal((await lstat(join(target, "empty"))).isDirectory(), true);
  await assert.rejects(copyTree(source, target, items), /EEXIST/);
  await writeFile(join(source, "hello.txt"), "xyz"); // identical size, changed bytes
  await assert.rejects(copyTree(source, join(root, "tampered"), items), /무결성/);
  assert.equal(await readFile(join(target, "hello.txt"), "utf8"), "abc");
});

test("actual bundle corruption, extra file and missing file fail hash validation", async () => {
  const parent = await temp();
  const id = `backup-20260912T000000Z-${randomUUID().slice(0, 8)}`;
  const root = join(parent, id); await mkdir(root);
  await writeFile(join(root, "database.dump"), "abc");
  await mkdir(join(root, "workspace")); await mkdir(join(root, "checkpoints"));
  const files = await inventory(root);
  const key = Buffer.alloc(32, 7);
  const tables = ["organizations", "sessions", "messages", "workspace_files", "collab_docs", "memory_items", "code_chunks", "execution_runs", "execution_actions", "schema_migrations"].map(name => ({ name, rows: 0, sha256: hash("") }));
  const manifest = { version: 1, id, createdAt: new Date().toISOString(), bytes: 3, scope: { workspaceRoot: "/Volumes/T7/bigdata/workspaces/my-first-project", checkpointRoot: "/Volumes/T7/bigdata/checkpoints/stage3" }, database: { tables, sequences: [] }, checkpoints: { checked: 0, otherWorkspaceRuns: 0 }, files };
  manifest.signature = signManifest(manifest, key);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  assert.equal((await verifyBundle(root, key)).id, id);
  const noTables = { ...manifest, database: { tables: [], sequences: [] } };
  noTables.signature = signManifest(noTables, key);
  await writeFile(join(root, "manifest.json"), JSON.stringify(noTables));
  await assert.rejects(verifyBundle(root, key), /필수 DB 테이블/);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "database.dump"), "xyz");
  await assert.rejects(verifyBundle(root, key), /누락·추가·변경/);
  await writeFile(join(root, "database.dump"), "abc");
  await writeFile(join(root, "unexpected.txt"), "extra");
  await assert.rejects(verifyBundle(root, key), /누락·추가·변경/);
  manifest.files = [...files, entry("missing.txt")];
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(root, key), /서명/);
  manifest.bytes = 6; manifest.signature = signManifest(manifest, key);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(root, key), /누락·추가·변경/);
  manifest.files = []; manifest.bytes = 0; manifest.signature = signManifest(manifest, key);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(root, key), /크기/);
});

test("real checkpoint loss, bytes corruption and DB metadata mismatch block backup", async () => {
  const store = await temp(); const id = randomUUID(); const before = Buffer.from("before");
  const cp = { path: "file.txt", before: before.toString("base64"), beforeHash: hash(before), after: "after", afterHash: hash("after"), mode: 0o644 };
  const row = { id, arguments: { path: "file.txt" }, before_hash: cp.beforeHash, after_hash: cp.afterHash };
  const client = { query: async sql => ({ rows: sql.startsWith("select a.id") ? [row] : [{ n: 0 }] }) };
  await assert.rejects(checkpointIntegrity(client, "/workspace", store), /ENOENT/);
  await writeFile(join(store, `${id}.json`), JSON.stringify(cp));
  assert.equal((await checkpointIntegrity(client, "/workspace", store)).checked, 1);
  await writeFile(join(store, `${id}.json`), JSON.stringify({ ...cp, after: "wrong" }));
  await assert.rejects(checkpointIntegrity(client, "/workspace", store), /일치하지/);
  await writeFile(join(store, `${id}.json`), JSON.stringify(cp));
  row.after_hash = hash("different");
  await assert.rejects(checkpointIntegrity(client, "/workspace", store), /일치하지/);
  row.arguments.path = "../escape";
  await writeFile(join(store, `${id}.json`), JSON.stringify({ ...cp, path: "../escape" }));
  await assert.rejects(checkpointIntegrity(client, "/workspace", store), /범위/);
});

test("fresh install permits missing checkpoint folder only without database references", async () => {
  const root = await temp(); const missingStore = join(root, "not-created-yet");
  const emptyClient = { query: async sql => ({ rows: sql.startsWith("select a.id") ? [] : [{ n: 0 }] }) };
  assert.deepEqual(await checkpointIntegrity(emptyClient, "/workspace", missingStore), { checked: 0, otherWorkspaceRuns: 0 });
  const referenced = { query: async () => ({ rows: [{ id: randomUUID(), arguments: { path: "x" } }] }) };
  await assert.rejects(checkpointIntegrity(referenced, "/workspace", missingStore), /ENOENT/);
});

test("active/stale startup lock and failed flush record block consistency claims", async () => {
  const root = await temp(); await writeFile(join(root, "port-8791.lock"), "untrusted stale lock");
  const client = { query: async () => ({ rows: [{ n: 0 }] }) };
  await assert.rejects(assertQuiescent(client, root), /실행 중/);
  const root2 = await temp(); await mkdir(join(root2, "runtime"));
  await writeFile(join(root2, "runtime/runtime.json"), JSON.stringify({ state: "failed" }));
  await assert.rejects(assertQuiescent(client, root2), /정상 종료/);
});

test("existing system symlink is rejected without following it", async t => {
  if (!(await lstat("/var")).isSymbolicLink()) { t.skip("이 플랫폼의 /var는 링크가 아님"); return; }
  await assert.rejects(noLinks("/var"), /심볼릭 링크/);
});
