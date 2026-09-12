#!/usr/bin/env node
// 설치 가능한 소스를 묶는다. 사용자 DB·비밀 설정·의존성은 배포물이 아니다.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = "/Volumes/T7/bigdata/releases/local";
const RUN = "/Volumes/T7/bigdata/run/local-app";
const ID = /^release-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const MAX_FILE = 32 * 1024 ** 2;
const MAX_TOTAL = 128 * 1024 ** 2;
const MAX_FILES = 10_000;
const APPS = ["api", "web", "cli", "verify", "demo"];
const PACKAGES = ["ai", "collab", "indexer", "memory", "plugin-host", "sdk", "shared", "tools"];
const TOP = new Set([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json", "turbo.json",
  "vitest.shared.ts", "eslint.config.js", "docker-compose.yml", ".env.example", ".npmrc", ".gitignore", ".gitattributes",
  "AGENTS.md", "CLAUDE.md", "HANDOFF.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "처음 사용하기.md", "aios-chat.html", "vercel.json", ".vercelignore",
  "AIOS 시작.command", "AIOS 종료.command", "AIOS 상태 확인.command", "AIOS 백업.command",
  "AIOS 복원 검사.command", "AIOS 사용 패키지 만들기.command",
]);
const TREES = [
  ...APPS.flatMap(name => [`apps/${name}/src`]), "apps/web/e2e", "apps/web/public", "apps/demo/public", "apps/demo/e2e",
  ...PACKAGES.flatMap(name => [`packages/${name}/src`, `packages/${name}/scripts`]), "extensions/vscode/src", "plugins/hello-world",
  "infra", "scripts", "docs", "tools/bigdata", ".github/workflows",
];
const PROJECTS = [...APPS.map(name => `apps/${name}`), ...PACKAGES.map(name => `packages/${name}`), "extensions/vscode"];
const CONFIGS = ["package.json", "tsconfig.json", "vitest.config.ts", "vite.config.ts", "playwright.config.ts", "a11y.config.ts", "index.html"];
const CONFIG_PATHS = new Set(PROJECTS.flatMap(project => CONFIGS.map(name => `${project}/${name}`)));
const BLOCKED = new Set(["node_modules", "dist", ".git", ".turbo", ".cache", "cache", "__pycache__", ".pytest_cache", ".venv", "venv", "env", "secrets", "backups", "backup", "logs", "coverage", "test-results", "playwright-report", "blob-report", "outputs", "tmp", "temp", "work", "models", "databases", ".ds_store"]);
const EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|html|css|scss|svg|png|jpg|jpeg|webp|woff2?|md|sh|sql|tpl|py|snap)$/i;
const REQUIRED = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".env.example", "README.md", "HANDOFF.md", "처음 사용하기.md", "apps/api/src/main.ts", "apps/web/src/main.tsx", "infra/migrations/0005_execution_safety.sql", "scripts/start-local.sh"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const normalize = value => value.normalize("NFC");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function safePath(path) {
  if (typeof path !== "string" || path.length > 1024 || path.includes("\\") || [...path].some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
    || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("안전하지 않은 패키지 상대 경로입니다.");
  return normalize(path);
}

function excluded(path) {
  const parts = path.split("/");
  return parts.some(part => BLOCKED.has(part.toLowerCase()) || part.startsWith("._")
    || (part.toLowerCase().startsWith(".env") && path !== ".env.example")
    || /^(?:credentials|private[-_]?key|api[-_]?key)\.(?:json|txt|yaml|yml)$/i.test(part))
    || /\.(?:log|jsonl|dump|db|sqlite3?|duckdb|parquet|pem|key|p12|pfx|tgz|gz|zip|bak|tmp)$/i.test(path);
}

/** 새 폴더를 무조건 포함하지 않는다. 필요한 제품 코드 경로만 명시적으로 허용한다. */
export function allowedFile(raw) {
  const path = safePath(raw);
  if (excluded(path)) return false;
  if (TOP.has(path) || CONFIG_PATHS.has(path)) return true;
  return TREES.some(tree => path.startsWith(tree + "/")) && (EXT.test(path) || /(?:^|\/)\w*\.?Dockerfile$/.test(path));
}

function allowedDirectory(raw) {
  const path = safePath(raw);
  if (excluded(path)) return false;
  return TREES.some(tree => path === tree || path.startsWith(tree + "/") || tree.startsWith(path + "/"))
    || PROJECTS.some(project => path === project || project.startsWith(path + "/"));
}

async function noLinks(path) {
  let cursor = resolve(path);
  for (;;) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("심볼릭 링크는 패키지 경로로 사용할 수 없습니다.");
    if (cursor === dirname(cursor)) return;
    cursor = dirname(cursor);
  }
}

async function digestFile(path, limit = MAX_FILE) {
  await noLinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("패키지는 크기 제한 내의 일반 단일 링크 파일만 지원합니다.");
    const digest = createHash("sha256"); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length; if (size > limit) throw new Error("파일 크기 제한 초과"); digest.update(chunk);
    }
    const after = await file.stat();
    if (size !== before.size || before.mtimeMs !== after.mtimeMs || after.size !== size || after.nlink !== 1) throw new Error("패키지 작성 중 소스가 변경됐습니다.");
    return { size, sha256: digest.digest("hex"), mode: before.mode & 0o777, mtimeMs: before.mtimeMs };
  } finally { await file.close(); }
}

export async function sourceInventory(root) {
  await noLinks(root);
  const result = []; const names = new Set(); let total = 0;
  async function walk(directory, prefix) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + item.name;
      if (!allowedFile(path) && !allowedDirectory(path)) continue;
      const key = safePath(path).toLowerCase();
      if (names.has(key)) throw new Error("정규화 또는 대소문자가 중복되는 소스 경로입니다.");
      names.add(key);
      if (names.size > MAX_FILES * 2) throw new Error("소스 경로 개수 제한 초과");
      const absolute = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("허용된 소스 경로에 심볼릭 링크가 있습니다.");
      if (item.isDirectory()) { if (allowedDirectory(path)) await walk(absolute, path + "/"); continue; }
      if (!allowedFile(path)) continue;
      const metadata = await digestFile(absolute); total += metadata.size;
      if (result.length >= MAX_FILES || total > MAX_TOTAL) throw new Error("소스 패키지 한도(1만 파일·128 MiB)를 초과했습니다.");
      result.push({ path, ...metadata });
    }
  }
  await walk(root, "");
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function sourceHash(files) {
  return hash(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path: normalize(path), size, sha256 }))));
}

async function writeExclusive(path, value) {
  await noLinks(dirname(path));
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}

async function copySources(source, stage, files) {
  for (const item of files) {
    const target = join(stage, item.path); await mkdir(dirname(target), { recursive: true }); await noLinks(dirname(target));
    const input = join(source, item.path);
    await noLinks(input);
    const from = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await from.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) throw new Error("복사 전에 소스가 변경됐습니다.");
      const to = await open(target, "wx", item.mode);
      try {
        const digest = createHash("sha256"); let size = 0;
        for await (const chunk of from.createReadStream({ autoClose: false })) {
          size += chunk.length; if (size > item.size) throw new Error("복사 중 소스 크기가 변경됐습니다.");
          digest.update(chunk); await to.writeFile(chunk);
        }
        if (size !== item.size || digest.digest("hex") !== item.sha256) throw new Error("복사 중 소스 내용이 변경됐습니다.");
        await to.sync();
      } finally { await to.close(); }
    } finally { await from.close(); }
  }
}

/** sourceRoot/releaseRoot는 독립 시험용 주입점이다. CLI는 고정 T7 경로만 사용한다. */
export async function createPackage({ sourceRoot = REPO, releaseRoot = RELEASES, id = `release-${stamp()}-${randomUUID().slice(0, 8)}`, afterSnapshot } = {}) {
  if (!ID.test(id)) throw new Error("릴리스 ID 형식 오류");
  await noLinks(sourceRoot); await mkdir(releaseRoot, { recursive: true }); await noLinks(releaseRoot);
  const final = join(releaseRoot, id); const partial = `${final}.partial`;
  if (await lstat(final).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("이미 존재하는 릴리스는 덮어쓰지 않습니다.");
  await mkdir(partial); // 불완전한 이전 결과도 재사용하지 않는다.
  const stage = join(partial, "source"); await mkdir(stage);
  const files = await sourceInventory(sourceRoot);
  const available = new Set(files.map(file => normalize(file.path)));
  if (REQUIRED.some(path => !available.has(path))) throw new Error("재설치에 필요한 소스·설정·문서가 빠져 있습니다.");
  if (available.has(".npmrc")) {
    const npmrc = await readFile(join(sourceRoot, ".npmrc"), "utf8");
    if (npmrc.split(/\r?\n/).some(line => !/^\s*[#;]/.test(line) && /(?:_authToken|_password|_auth)\s*=\s*(?!\$\{)\S/i.test(line))) {
      throw new Error(".npmrc에 인증 정보가 있어 패키지 생성을 중단했습니다. 비밀 설정을 별도로 보관하세요.");
    }
  }
  await afterSnapshot?.();
  await copySources(sourceRoot, stage, files);
  const codeHash = sourceHash(files);
  if (sourceHash(await sourceInventory(stage)) !== codeHash) throw new Error("패키지에 복사된 소스의 무결성 오류");
  const archive = `${id}.tar.gz`;
  await exec("tar", ["--no-xattrs", "--no-acls", "-czf", join(partial, archive), "-C", stage, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 120_000, maxBuffer: 1024 ** 2,
  });
  if (JSON.stringify(await sourceInventory(sourceRoot)) !== JSON.stringify(files)) throw new Error("패키지 작성 중 소스가 변경됐습니다. .partial 결과를 사용하지 말고 다시 실행하세요.");
  const archiveDigest = await digestFile(join(partial, archive), MAX_TOTAL);
  const info = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
  const manifest = {
    version: 1, id, createdAt: new Date().toISOString(), productVersion: info.version,
    node: process.version, platform: process.platform, arch: process.arch, packageManager: info.packageManager,
    codeHash, archive: { file: archive, bytes: archiveDigest.size, sha256: archiveDigest.sha256 },
    sourceFiles: files.map(({ mtimeMs: _mtime, ...entry }) => entry),
    scope: "재설치용 소스 패키지. 실행 바이너리·앱 설치 프로그램·사용자 데이터 백업이 아닙니다.",
    requirements: ["이 Mac의 로컬 T7 환경을 기준으로 작성했습니다. 다른 OS·기기로의 설치는 미검증입니다.",
      "Node.js·pnpm·Docker/Colima·Ollama를 별도 준비하고 pnpm install --frozen-lockfile로 의존성을 설치해야 합니다.",
      ".env.local과 모델·DB·작업 폴더·체크포인트는 별도로 준비/복원해야 합니다. 비밀 설정을 자동 복사하지 않습니다."],
    excluded: [".env 및 .env.local 등 비밀 환경 파일(.env.example만 포함)", "secrets/·백업·DB·모델", "node_modules/·dist/·.git/", "로그·캐시·임시 테스트 출력·macOS ._*"],
  };
  await writeExclusive(join(partial, `${archive}.sha256`), `${archiveDigest.sha256}  ${archive}\n`);
  await writeExclusive(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (JSON.stringify(await sourceInventory(sourceRoot)) !== JSON.stringify(files)) throw new Error("패키지 완료 전에 소스가 변경됐습니다. .partial 결과를 사용하지 마세요.");
  // 이번 호출이 독점 생성한 staging 복사본만 제거한다. 프로젝트 원본은 변경하지 않는다.
  await rm(stage, { recursive: true, force: false });
  if (await lstat(final).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("이미 존재하는 릴리스는 덮어쓰지 않습니다.");
  await rename(partial, final);
  return { status: "passed", id, directory: final, archive: join(final, archive), sha256: archiveDigest.sha256, codeHash, files: files.length, bytes: archiveDigest.size };
}

async function withMaintenance(work) {
  await mkdir(RUN, { recursive: true }); await noLinks(RUN);
  const lock = join(RUN, "maintenance.lock"); await mkdir(lock);
  const instanceId = randomUUID();
  try {
    await writeExclusive(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, instanceId, purpose: "package", projectRoot: REPO, createdAt: new Date().toISOString() }));
    return await work();
  } finally {
    const owner = await readFile(join(lock, "owner.json"), "utf8").then(JSON.parse).catch(() => null);
    if (owner?.instanceId === instanceId) { await unlink(join(lock, "owner.json")); await rmdir(lock); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("사용법: node scripts/package-local.mjs (인자 없음)");
    if (!normalize(REPO).startsWith("/Volumes/T7/") || normalize(await realpath(REPO)) !== normalize(REPO)) throw new Error("실제 T7 프로젝트에서만 실행할 수 있습니다.");
    process.env.PATH = `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;
    console.log(JSON.stringify(await withMaintenance(() => createPackage()), null, 2));
  } catch (error) {
    // 환경 변수나 파일 내용을 진단 출력에 섞지 않는다.
    console.error(`패키지 생성 실패: ${error.code === "EEXIST" ? "기존 결과 또는 유지보수 잠금이 있습니다." : error.message}`);
    process.exitCode = 1;
  }
}
