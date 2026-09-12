#!/usr/bin/env node
/** 단일 Mac용 감독자. PID 생성시각·명령·cwd·포트를 확인하고 공유 DB/Redis/Ollama는 보존한다. */
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const ROOT = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = "/Volumes/T7/bigdata/run/local-app";
const LOGS = "/Volumes/T7/bigdata/logs/local-app";
const normalize = (value) => value.normalize("NFC");
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && normalize(resolve(a)) === normalize(resolve(b));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

export function runtimePaths(root, port, base = BASE) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error("AIOS_LOCAL_PORT는 1024~65535 정수여야 합니다.");
  const directory = join(base, `${digest(normalize(resolve(root))).slice(0, 16)}-${Number(port)}`);
  return { base, directory, manifest: join(directory, "runtime.json"), build: join(directory, "build.json"), lock: join(base, `port-${Number(port)}.lock`), maintenance: join(base, "maintenance.lock") };
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error(`상태 파일을 읽지 못했습니다: ${path}. 임의로 삭제하지 말고 확인하세요.`); }
}

async function saveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    const [{ stdout: started }, { stdout: command }, { stdout: cwd }] = await Promise.all([
      exec("ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } }),
      exec("ps", ["-p", String(pid), "-o", "command="]),
      exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
    ]);
    const directory = cwd.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    if (!started.trim() || !command.trim() || !directory) return null;
    return { pid, startedAt: started.trim(), command: command.trim(), cwd: directory };
  } catch { return null; }
}

export async function matchesIdentity(identity, root, role) {
  if (!identity || !samePath(identity.cwd, root)) return false;
  const now = await processIdentity(identity.pid);
  if (!now || now.startedAt !== identity.startedAt || now.command !== identity.command || !samePath(now.cwd, root)) return false;
  // 관측한 임의 프로세스를 기록에 끼워 넣는 것만으로 종료 권한이 생기지 않게 한다.
  const expected = role === "launcher" ? join(root, "scripts/local-lifecycle.mjs") : role === "api" ? join(root, "apps/api/dist/main.js") : role === "worker" ? join(root, "apps/api/dist/worker.js") : null;
  if (expected) {
    const command = normalize(now.command).replace(/^(?:\S*\/)?node(?:[0-9.]*)? /, "");
    return role === "launcher" ? command === `${normalize(expected)} start` || command === `${normalize(expected)} start --json` : command === normalize(expected);
  }
  return role === "awake" && /(^|\/)caffeinate -i -w \d+$/.test(now.command);
}

export async function listeningPids(port) {
  try {
    const { stdout } = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return [...new Set(stdout.trim().split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1))];
  } catch (error) { if (error.code === 1 && !error.stdout?.trim()) return []; throw new Error("포트 소유권을 검사하지 못했습니다. lsof 설치/권한을 확인하세요."); }
}

export async function acquirePortLock(paths, owner) {
  await mkdir(paths.directory, { recursive: true });
  try {
    const handle = await open(paths.lock, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`); } finally { await handle.close(); }
    return;
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const previous = await readJson(paths.lock);
  if (!previous?.launcher || !samePath(previous.projectRoot, owner.projectRoot) || previous.port !== owner.port) throw new Error("다른 프로젝트 또는 불명확한 시작 잠금이 있습니다. 상태 확인 후 수동 점검하세요. 자동 삭제하지 않았습니다.");
  if (await matchesIdentity(previous.launcher, previous.projectRoot, "launcher")) throw new Error("AIOS가 시작/실행/종료 중입니다. 상태 확인.command를 사용하세요.");
  if ((await listeningPids(owner.port)).length) throw new Error("이전 시작기는 종료됐지만 포트가 사용 중입니다. 다른 프로세스를 종료하지 않았습니다.");
  // 잘못된 PID 기록을 죽이지 않는다. 경합하는 stale 회수는 별도 디렉터리 잠금으로 직렬화한다.
  const recovery = `${paths.lock}.recovery`;
  try { await mkdir(recovery); } catch { throw new Error("이전 시작 잠금을 다른 시작기가 확인 중입니다. 잠시 뒤 다시 실행하세요."); }
  try {
    const again = await readJson(paths.lock);
    if (again?.instanceId !== previous.instanceId) throw new Error("시작 잠금이 변경되었습니다. 다시 실행하세요.");
    await unlink(paths.lock);
    const handle = await open(paths.lock, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`); } finally { await handle.close(); }
  } finally {
    const { rmdir } = await import("node:fs/promises");
    await rmdir(recovery);
  }
}

export async function releasePortLock(paths, instanceId) {
  const current = await readJson(paths.lock);
  if (current?.instanceId === instanceId) await unlink(paths.lock);
}

export async function assertStartAllowed(paths, port) {
  if (await exists(paths.maintenance)) throw new Error("백업/복원 확인/배포 묶음 준비 중입니다. 유지보수 잠금이 해제된 뒤 시작하세요. 오래된 잠금도 자동 삭제하지 않습니다.");
  if ((await listeningPids(port)).length) throw new Error(`${port} 포트를 다른 프로그램이 사용 중입니다. 소유권을 확인하지 못해 종료하지 않았습니다.`);
}

async function ready(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2500) }); return response.ok && (await response.json()).ready === true; }
  catch { return false; }
}

export async function inspectRuntime(root, port, paths = runtimePaths(root, port)) {
  const state = await readJson(paths.manifest);
  const maintenance = await exists(paths.maintenance);
  const pids = await listeningPids(port);
  const base = { schemaVersion: 1, projectRoot: root, port: Number(port), url: `http://127.0.0.1:${port}`, maintenance, manifestPath: paths.manifest, logsPath: LOGS };
  if (!state) return { ...base, state: pids.length ? "conflict" : "stopped", healthy: false, exitCode: pids.length ? 2 : 1, message: pids.length ? "이 시작기가 관리하지 않는 서버가 포트를 사용 중입니다. 자동 종료하지 않습니다." : "AIOS가 실행 중이 아닙니다.", listeningPids: pids };
  if (state.schemaVersion !== 1 || !samePath(state.projectRoot, root) || state.port !== Number(port)) throw new Error("상태 파일의 프로젝트/포트가 일치하지 않습니다.");
  const launcherAlive = await matchesIdentity(state.launcher, root, "launcher");
  const apiAlive = await matchesIdentity(state.children?.api, root, "api");
  const workerAlive = await matchesIdentity(state.children?.worker, root, "worker");
  const ownsPort = pids.length === 1 && pids[0] === state.children?.api?.pid;
  const healthy = state.state === "ready" && launcherAlive && apiAlive && workerAlive && ownsPort && await ready(port);
  const conflict = pids.length > 0 && !ownsPort;
  const observed = conflict ? "conflict" : healthy ? "ready" : launcherAlive && ["starting", "stopping"].includes(state.state) ? state.state : state.state === "stopped" && !pids.length && !launcherAlive && !apiAlive && !workerAlive ? "stopped" : "failed";
  return { ...base, state: observed, healthy, exitCode: conflict ? 2 : healthy ? 0 : 1, instanceId: state.instanceId, startedAt: state.startedAt, updatedAt: state.updatedAt, launcherAlive, apiAlive, workerAlive, ownsPort, listeningPids: pids, build: state.build, message: healthy ? "AIOS 준비 완료 · API/워커/DB/Redis 확인" : conflict ? "포트 소유권 불일치. 자동 종료하지 않습니다." : observed === "failed" && state.state === "ready" ? "실행 기록은 ready이나 현재 프로세스/의존성이 정상적이지 않습니다. 로그를 확인하세요." : state.message || "로그를 확인하세요." };
}

async function hashFile(path, hash) { for await (const chunk of createReadStream(path)) hash.update(chunk); }

async function hashTree(root, path, hash) {
  const entry = await lstat(path);
  const name = relative(root, path).split("/").map(normalize).join("/");
  hash.update(`${name}\0`);
  if (entry.isSymbolicLink()) {
    const target = await realpath(path);
    if (!normalize(target).startsWith(`${normalize(root)}/`)) throw new Error(`빌드 입력 심볼릭 링크가 프로젝트 밖을 가리킵니다: ${name}`);
    hash.update(`link:${normalize(target)}\0`);
    // 링크의 대상 내용이 변해도 기존 빌드 재사용이 되지 않게 실제 내용을 해시한다.
    if ((await lstat(target)).isFile()) await hashFile(target, hash);
    else throw new Error(`빌드 입력 디렉터리 심볼릭 링크는 지원하지 않습니다: ${name}`);
  } else if (entry.isDirectory()) {
    const names = (await readdir(path)).filter((item) => !item.startsWith("._") && !["node_modules", "dist", ".turbo", ".git", ".DS_Store", ".npmrc", "test-results", "playwright-report"].includes(item) && !item.startsWith(".env")).sort();
    for (const child of names) await hashTree(root, join(path, child), hash);
  } else if (entry.isFile()) await hashFile(path, hash);
  hash.update("\0");
}

let installedReads = 0;
const installedWaiters = [];
async function hashInstalledFile(path, hash) {
  if (installedReads >= 8) await new Promise((resume) => installedWaiters.push(resume));
  else installedReads++;
  try { await hashFile(path, hash); }
  finally { const next = installedWaiters.shift(); if (next) next(); else installedReads--; }
}

async function hashInstalledTree(root, path) {
  const hash = createHash("sha256");
  hash.update(`${normalize(relative(root, path))}\0`);
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    const target = await realpath(path);
    if (!normalize(target).startsWith(`${normalize(root)}/`)) throw new Error(`의존성 링크가 프로젝트 밖을 가리킵니다: ${relative(root, path)}. 잠금 파일에 맞춰 설치를 확인하세요.`);
    hash.update(`link:${normalize(await readlink(path))}\0`);
  }
  else if (entry.isDirectory()) {
    const names = (await readdir(path)).filter((name) => !name.startsWith("._") && !name.startsWith(".env") && ![".cache", ".vite", ".DS_Store", ".npmrc"].includes(name)).sort();
    // 순서는 고정하고 읽기만 병렬화한다. 내용 해시를 mtime으로 대체하면 동일 크기 변조를 놓친다.
    for (const childHash of await Promise.all(names.map((name) => hashInstalledTree(root, join(path, name))))) hash.update(childHash);
  } else if (entry.isFile()) await hashInstalledFile(path, hash);
  hash.update("\0");
  return hash.digest("hex");
}

/** 소스·설정·잠금·설치 메타데이터·실제 산출물 모두 일치해야 재사용한다. 비밀 파일/환경값은 기록하지 않는다. */
export async function buildFingerprint(root) {
  const hash = createHash("sha256").update(`local-build-v2\0${process.version}\0${process.platform}\0${process.arch}\0`);
  for (const name of ["apps/api", "apps/web", "packages", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json", "turbo.json", "scripts/build-node-app.mjs"]) {
    const path = join(root, name);
    if (await exists(path)) await hashTree(root, path, hash); else hash.update(`missing:${name}\0`);
  }
  // 설치 디렉터리를 수동 수정한 경우도 검출한다. mtime·파일 크기만으로 캐시를 신뢰하지 않는다.
  const moduleDirs = ["node_modules", "apps/api/node_modules", "apps/web/node_modules"];
  for (const name of await readdir(join(root, "packages"))) if (!name.startsWith("._")) moduleDirs.push(`packages/${name}/node_modules`);
  for (const name of moduleDirs) if (await exists(join(root, name))) hash.update(await hashInstalledTree(root, join(root, name)));
  // Vite 환경 파일/환경 변수는 비밀을 해시로도 내보내지 않는다. 사용 시 캐시를 끈다.
  const environmentInputs = (await readdir(join(root, "apps/web"))).some((name) => name.startsWith(".env")) || Object.keys(process.env).some((key) => key.startsWith("VITE_"));
  return { inputHash: hash.digest("hex"), cacheable: !environmentInputs };
}

export async function outputFingerprint(root) {
  const paths = ["apps/api/dist/main.js", "apps/api/dist/worker.js", "apps/api/dist/bigdata-worker.js", "apps/web/dist/index.html"];
  if (!(await Promise.all(paths.map((path) => exists(join(root, path))))).every(Boolean)) return null;
  const hash = createHash("sha256");
  for (const name of ["apps/api/dist", "apps/web/dist"]) await hashTree(root, join(root, name), hash);
  return hash.digest("hex");
}

export async function canReuseBuild(root, manifestPath) {
  const inputs = await buildFingerprint(root);
  const outputs = await outputFingerprint(root);
  const previous = await readJson(manifestPath);
  return { ...inputs, outputHash: outputs, reuse: process.env.AIOS_FORCE_BUILD !== "1" && inputs.cacheable && outputs !== null && previous?.inputHash === inputs.inputHash && previous?.outputHash === outputs };
}

async function available(command) { try { await exec("/bin/bash", ["-c", 'command -v "$1" >/dev/null', "check", command]); return true; } catch { return false; } }

export async function environmentDiagnostics(root) {
  const [configurationPresent, dependenciesPresent, docker, models] = await Promise.all([
    exists(join(root, ".env.local")), exists(join(root, "node_modules/.bin/pnpm")),
    exec("docker", ["inspect", "1ai-postgres-1", "1ai-redis-1", "--format", "{{.State.Health.Status}}"], { timeout: 5000 }).then(({ stdout }) => {
      const values = stdout.trim().split(/\s+/); return { available: true, postgres: values[0] || "unknown", redis: values[1] || "unknown" };
    }).catch(() => ({ available: false, postgres: "unknown", redis: "unknown" })),
    fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) }).then(async (response) => {
      if (!response.ok) return { available: false, names: [] };
      const data = await response.json();
      return { available: Array.isArray(data.models), names: (data.models || []).map((model) => model.name).filter((name) => typeof name === "string") };
    }).catch(() => ({ available: false, names: [] })),
  ]);
  return { nodeVersion: process.version, configurationPresent, dependenciesPresent, docker, ollama: models };
}

async function start(root, port, paths) {
  const instanceId = randomUUID();
  const launcher = await processIdentity(process.pid);
  if (!launcher || !samePath(launcher.cwd, root)) throw new Error("시작기 작업 폴더를 확인할 수 없습니다. 프로젝트의 AIOS 시작.command를 사용하세요.");
  const previous = await inspectRuntime(root, port, paths);
  if (previous.healthy) { console.log(`AIOS가 이미 실행 중입니다: ${previous.url}`); if (process.env.AIOS_NO_OPEN !== "1") spawn("open", [`${previous.url}/#/chat`], { stdio: "ignore" }).unref(); return 0; }
  if (previous.apiAlive || previous.workerAlive || previous.launcherAlive) throw new Error("이전 AIOS 프로세스가 남아 있습니다. 먼저 AIOS 종료.command 및 상태 확인.command로 확인하세요. 중복 기동하지 않았습니다.");
  await acquirePortLock(paths, { schemaVersion: 1, instanceId, projectRoot: root, port, launcher, createdAt: new Date().toISOString() });
  // 유지보수 거부는 기존 정상 종료 기록을 failed로 덮어쓰지 않는다.
  try { await assertStartAllowed(paths, port); } catch (error) { await releasePortLock(paths, instanceId); throw error; }
  const state = { schemaVersion: 1, instanceId, projectRoot: root, port, url: `http://127.0.0.1:${port}`, state: "starting", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), launcher, children: {}, message: "기동 준비 중" };
  const children = new Map();
  let stopping = false;
  let interrupted = false;
  let activeCommand = null;
  const update = async (changes) => { Object.assign(state, changes, { updatedAt: new Date().toISOString() }); await saveJson(paths.manifest, state); };
  // 준비 명령은 별도 프로세스 그룹으로 묶어 pnpm 아래 esbuild만 고아로 남지 않게 한다.
  const signalCommand = () => { if (activeCommand?.pid && activeCommand.exitCode === null && !activeCommand.signalCode) { try { process.kill(-activeCommand.pid, "SIGTERM"); } catch { /* 이미 종료된 그룹에는 추가 신호를 보내지 않는다. */ } } };
  const onSignal = () => { interrupted = true; signalCommand(); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal); process.on("SIGHUP", onSignal);
  const ensureRunning = () => { if (interrupted) throw new Error("사용자가 시작/실행을 중단했습니다."); };
  const run = async (command, args, logfile, timeout = 180000) => {
    ensureRunning();
    const log = createWriteStream(join(LOGS, logfile), { flags: "w", mode: 0o600 });
    const child = spawn(command, args, { cwd: root, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeCommand = child; child.stdout.pipe(log); child.stderr.pipe(log);
    try {
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => { signalCommand(); reject(new Error(`준비 시간 초과: ${join(LOGS, logfile)}`)); }, timeout);
        child.once("error", () => { clearTimeout(timer); reject(new Error(`실행 실패: ${command}. ${join(LOGS, logfile)}`)); });
        child.once("exit", (code, signal) => { clearTimeout(timer); if (code === 0) accept(); else reject(new Error(`준비 실패 (${command}, ${code ?? signal}): ${join(LOGS, logfile)}`)); });
      });
    } finally { activeCommand = null; log.end(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
    ensureRunning();
  };
  const spawnOwned = async (role, command, args, logfile) => {
    const log = createWriteStream(join(LOGS, logfile), { flags: "w", mode: 0o600 });
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log); child.stderr.pipe(log); child.once("error", () => {}); child.once("exit", () => log.end());
    children.set(role, child);
    for (let i = 0; i < 20; i++) {
      const identity = await processIdentity(child.pid);
      if (identity) { state.children[role] = identity; await update({}); return child; }
      if (child.exitCode !== null || child.signalCode) break;
      await delay(50);
    }
    throw new Error(`${role} 프로세스 시작 실패: ${join(LOGS, logfile)}`);
  };
  const shutdown = async () => {
    if (stopping) return [];
    stopping = true;
    await update({ state: "stopping", message: "API와 워커의 저장·종료를 기다리는 중" });
    const failures = [];
    for (const [role, child] of children) {
      if (child.exitCode === null && !child.signalCode) {
        if (await matchesIdentity(state.children[role], root, role)) child.kill("SIGTERM");
        else failures.push(`${role}: 프로세스 신원 불일치 (종료하지 않음)`);
      }
    }
    const deadline = Date.now() + 30000;
    while ([...children.values()].some((child) => child.exitCode === null && !child.signalCode) && Date.now() < deadline) await delay(200);
    for (const [role, child] of children) {
      if (child.exitCode === null && !child.signalCode) failures.push(`${role}: 종료 시간 초과 (강제 종료하지 않음)`);
      else if (role !== "awake" && child.exitCode !== 0) failures.push(`${role}: 비정상 종료 ${child.exitCode ?? child.signalCode}`);
    }
    if ((await listeningPids(port)).length) failures.push("사용 포트가 아직 열려 있음");
    return failures;
  };
  let result = 1;
  let failure = "";
  try {
    await mkdir(LOGS, { recursive: true });
    await update({});
    if (!normalize(root).startsWith("/Volumes/T7/")) throw new Error("프로젝트는 T7에 있어야 합니다.");
    if (!process.env.OLLAMA_MODELS?.startsWith("/Volumes/T7/")) throw new Error("모델 경로는 T7 안에 있어야 합니다.");
    for (const command of ["node", "docker", "docker-compose", "ollama", "lsof"]) if (!await available(command)) throw new Error(`${command} 실행 파일이 없습니다. 의존성을 확인하세요. 자동 설치하지 않았습니다.`);
    const pnpm = join(root, "node_modules/.bin/pnpm");
    if (!await exists(pnpm)) throw new Error("프로젝트 의존성이 없습니다. 기존 pnpm 잠금 파일에 맞춘 설치가 필요합니다.");
    console.log("AIOS를 준비합니다. 진행 상태는 AIOS 상태 확인.command에서 확인할 수 있습니다.");
    try { await exec("docker", ["info"], { timeout: 15000 }); }
    catch { if (!await available("colima")) throw new Error("Docker가 실행 중이 아니고 Colima도 없습니다. 환경을 확인하세요."); await update({ message: "Docker 환경 시작 중" }); await run("colima", ["start"], "docker-start.log", 240000); }
    await update({ message: "DB·Redis 준비 중" });
    await run("docker-compose", ["-p", "1ai", "up", "-d", "postgres", "redis"], "database-start.log");
    let databasesReady = false;
    for (let i = 0; i < 60; i++) {
      ensureRunning();
      try { const { stdout } = await exec("docker", ["inspect", "1ai-postgres-1", "1ai-redis-1", "--format", "{{.State.Health.Status}}"], { timeout: 5000 }); const values = stdout.trim().split(/\s+/); databasesReady = values.length === 2 && values.every((value) => value === "healthy"); } catch { /* 부팅 중 상태는 다음 검사에서 재확인한다. */ }
      if (databasesReady) break;
      await delay(1000);
    }
    if (!databasesReady) throw new Error(`DB·Redis 준비 시간 초과: ${LOGS}/database-start.log`);
    await update({ message: "데이터베이스 마이그레이션 확인 중" });
    await run(process.execPath, [join(root, "scripts/migrate.mjs")], "migrate.log");
    const modelNames = async () => { try { const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) }); if (!response.ok) return null; return (await response.json()).models.map((model) => model.name); } catch { return null; } };
    if (!await modelNames()) {
      // 모델 서버는 이후 다른 앱도 사용할 수 있다. 이번에 시작했어도 공유 서비스로 남긴다.
      const log = await open(join(LOGS, "ollama.log"), "a", 0o600);
      const child = spawn("ollama", ["serve"], { cwd: root, env: process.env, stdio: ["ignore", log.fd, log.fd], detached: true });
      child.once("error", () => {}); child.unref(); await log.close();
    }
    await update({ message: "로컬 모델 확인 중" });
    let modelsReady = false;
    const required = [...(process.env.LOCAL_LLM_MODELS || "qwen3:8b").split(",").map((name) => name.trim()), process.env.LOCAL_EMBED_MODEL || "bge-m3"];
    for (let i = 0; i < 30; i++) { ensureRunning(); const names = await modelNames(); modelsReady = Boolean(names && required.every((name) => names.includes(name) || names.includes(`${name}:latest`))); if (modelsReady) break; await delay(1000); }
    if (!modelsReady) throw new Error("로컬 모델이 준비되지 않았습니다. Ollama 및 T7 모델 폴더를 확인하세요. 모델을 자동 다운로드하지 않았습니다.");
    const sandboxImage = process.env.SANDBOX_IMAGE || "aios-sandbox:latest";
    try { await exec("docker", ["image", "inspect", sandboxImage], { timeout: 10000 }); }
    catch { await update({ message: "샌드박스 이미지 준비 중" }); await run("docker", ["build", "-f", "infra/sandbox.Dockerfile", "-t", sandboxImage, "."], "sandbox-build.log", 300000); }
    const workspace = process.env.LOCAL_WORKSPACE_ROOT;
    if (!workspace || !workspace.startsWith("/Volumes/T7/bigdata/workspaces/")) throw new Error("전용 T7 작업 폴더 설정을 확인하세요.");
    await mkdir(workspace, { recursive: true });
    const probe = join(workspace, `.aios-mount-${randomUUID()}`);
    await writeFile(probe, "mount probe\n", { flag: "wx" });
    try { await run("docker", ["run", "--rm", "--network=none", "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`, sandboxImage, "test", "-f", `/workspace/${probe.split("/").at(-1)}`], "workspace-mount.log", 30000); }
    catch { throw new Error(`Docker에서 T7 작업 폴더가 보이지 않습니다. Colima에 /Volumes/T7/bigdata/workspaces 공유가 필요합니다. ${LOGS}/workspace-mount.log`); }
    finally { await unlink(probe); }
    await update({ message: "소스·빌드 산출물 확인 중" });
    const buildStarted = Date.now();
    const cached = await canReuseBuild(root, paths.build);
    if (!cached.reuse) {
      await update({ message: "변경된 화면·실행 파일 빌드 중" });
      console.log("변경된 소스 또는 빌드 산출물이 있어 빌드합니다…");
      await run(pnpm, ["--filter", "@aios/api", "--filter", "@aios/web", "build"], "build.log", 300000);
      const after = await buildFingerprint(root);
      if (after.inputHash !== cached.inputHash) throw new Error("빌드 중 소스가 변경됐습니다. 다시 시작하여 일치하는 빌드를 만드세요.");
      const outputHash = await outputFingerprint(root);
      if (!outputHash) throw new Error("빌드 산출물이 불완전합니다. build.log를 확인하세요.");
      await saveJson(paths.build, { schemaVersion: 1, inputHash: after.inputHash, outputHash, builtAt: new Date().toISOString() });
    } else console.log("소스와 산출물이 일치하여 기존 빌드를 재사용합니다.");
    await update({ build: { reused: cached.reuse, durationMs: Date.now() - buildStarted }, message: "API·워커 시작 중" });
    ensureRunning();
    await spawnOwned("api", process.execPath, [join(root, "apps/api/dist/main.js")], "api.log");
    await spawnOwned("worker", process.execPath, [join(root, "apps/api/dist/worker.js")], "worker.log");
    let readyNow = false;
    for (let i = 0; i < 60; i++) {
      ensureRunning();
      if ([...children.values()].some((child) => child.exitCode !== null || child.signalCode)) throw new Error(`API/워커가 시작 중 종료됐습니다. ${LOGS}/api.log 또는 worker.log를 확인하세요.`);
      const pids = await listeningPids(port);
      if (pids.length === 1 && pids[0] === state.children.api.pid && await ready(port)) { readyNow = true; break; }
      await delay(1000);
    }
    if (!readyNow) throw new Error(`API 준비 시간 초과: ${LOGS}/api.log`);
    if (await available("caffeinate")) await spawnOwned("awake", "caffeinate", ["-i", "-w", String(process.pid)], "awake.log");
    await update({ state: "ready", message: "준비 완료" });
    console.log(`AIOS 준비 완료: ${state.url}\n작업 파일: ${workspace}\n이 터미널을 열어 두세요. 종료: AIOS 종료.command 또는 Ctrl+C\nDB·Redis·Ollama는 종료하지 않습니다.`);
    if (process.env.AIOS_NO_OPEN !== "1") spawn("open", [`${state.url}/#/chat`], { stdio: "ignore" }).unref();
    while (!interrupted) {
      if ([...children.entries()].some(([role, child]) => role !== "awake" && (child.exitCode !== null || child.signalCode))) throw new Error(`API 또는 워커가 비정상 종료했습니다. 로그: ${LOGS}`);
      await delay(1000);
    }
    result = 0;
  } catch (error) { failure = error.message; console.error(failure); result = interrupted ? 0 : 1; }
  finally {
    const failures = await shutdown().catch((error) => [`종료 상태 확인 실패: ${error.message}`]);
    if (failures.length) { result = 1; failure = [failure, ...failures].filter(Boolean).join(" · "); }
    await update({ state: result === 0 ? "stopped" : "failed", message: result === 0 ? "AIOS 종료 완료. DB·Redis·Ollama는 유지됩니다." : failure, stoppedAt: new Date().toISOString(), exitCode: result });
    await releasePortLock(paths, instanceId);
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal); process.removeListener("SIGHUP", onSignal);
    console.log(state.message);
    for (const child of children.values()) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  }
  return result;
}

export async function stopRuntime(root, port, paths = runtimePaths(root, port)) {
  const state = await readJson(paths.manifest);
  const pids = await listeningPids(port);
  if (!state) return { exitCode: pids.length ? 2 : 0, message: pids.length ? "관리 기록 없는 서버가 포트를 사용 중입니다. 자동 종료하지 않았습니다." : "AIOS가 이미 종료되어 있습니다." };
  if (!samePath(state.projectRoot, root) || state.port !== Number(port)) throw new Error("종료 대상 프로젝트/포트가 일치하지 않습니다.");
  if (!await matchesIdentity(state.launcher, root, "launcher")) {
    const stopped = (await inspectRuntime(root, port, paths)).state === "stopped";
    return { exitCode: pids.length ? 2 : stopped ? 0 : 1, message: pids.length ? "시작기 신원을 확인하지 못했습니다. 남은 서버를 임의로 종료하지 않습니다." : stopped ? "AIOS가 이미 종료되어 있습니다." : "시작기가 사라진 비정상 상태입니다. 상태 확인과 로그 점검이 필요합니다." };
  }
  if (pids.some((pid) => pid !== state.children?.api?.pid)) return { exitCode: 2, message: "포트를 다른 프로세스가 사용 중입니다. 아무 프로세스도 종료하지 않았습니다." };
  // 메모리의 child 객체를 가진 정확한 감독자에게만 요청한다. 숫자로 자식들을 직접 죽이지 않는다.
  process.kill(state.launcher.pid, "SIGTERM");
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const current = await readJson(paths.manifest);
    if (current?.instanceId !== state.instanceId) return { exitCode: 2, message: "종료 도중 다른 실행으로 전환됐습니다. 추가 신호를 보내지 않았습니다." };
    if (["stopped", "failed"].includes(current?.state) && !await matchesIdentity(state.launcher, root, "launcher")) {
      const remaining = await listeningPids(port);
      return { exitCode: current.state === "stopped" && remaining.length === 0 ? 0 : 1, message: current.message };
    }
    await delay(250);
  }
  return { exitCode: 1, message: "종료 확인 시간이 초과됐습니다. 강제 종료하지 않았습니다. 상태 확인과 로그 점검이 필요합니다." };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["start", "stop", "status"].includes(command) || args.some((arg) => arg !== "--json")) throw new Error("사용법: node scripts/local-lifecycle.mjs start|stop|status [--json] (포트: AIOS_LOCAL_PORT)");
  const port = Number(process.env.AIOS_LOCAL_PORT || 8791);
  const paths = runtimePaths(ROOT, port);
  if (command === "start") return start(ROOT, port, paths);
  const result = command === "stop" ? await stopRuntime(ROOT, port, paths) : await inspectRuntime(ROOT, port, paths);
  if (command === "status") {
    result.environment = await environmentDiagnostics(ROOT);
    if (result.healthy && (!result.environment.ollama.available || result.environment.ollama.names.length === 0)) {
      result.state = "not_ready"; result.healthy = false; result.exitCode = 1;
      result.message = "API는 응답하지만 로컬 모델 서버/모델이 준비되지 않았습니다. Ollama 상태를 확인하세요.";
    }
  }
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else { console.log(result.message); if (command === "status") console.log(`상태: ${result.state} · ${result.url}\n유지보수 잠금: ${result.maintenance ? "있음 (기동 차단)" : "없음"}\nNode ${result.environment.nodeVersion} · 설정 ${result.environment.configurationPresent ? "있음" : "없음"} · 의존성 ${result.environment.dependenciesPresent ? "있음" : "없음"}\nPostgres ${result.environment.docker.postgres} · Redis ${result.environment.docker.redis} · Ollama ${result.environment.ollama.available ? "응답" : "응답 없음"}\n모델: ${result.environment.ollama.names.join(", ") || "확인 불가"}\n기록: ${result.manifestPath}\n로그: ${result.logsPath}\n설정의 비밀 값은 읽거나 표시하지 않았습니다. 자세한 안내는 처음 사용하기.md를 확인하세요.`); }
  return result.exitCode;
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`AIOS: ${error.message}`); process.exitCode = 2; }
}
