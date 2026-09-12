#!/usr/bin/env node
// 설치 전에 실행해야 하므로 외부 패키지를 import하지 않는다. 검사 중 설치·기동·설정 실행도 하지 않는다.
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM_VERSION = "9.12.0";
const LIMIT = 1024 * 1024;
const TIMEOUT = 2500;
const REQUIRED_CONFIG = ["DATABASE_URL", "LOCAL_LLM_BASE_URL"];
const PACKAGE_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;

function failed(error) {
  return { kind: error?.code === "ENOENT" ? "missing" : "failed" };
}

// execFile의 timeout은 실제로 이 검사가 만든 자식만 종료한다. stderr/예외 메시지는 비밀을 담을 수 있어 버린다.
export function readCommand(command, args, { timeoutMs = TIMEOUT, env = process.env } = {}) {
  return new Promise((done) => {
    execFile(command, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: LIMIT, encoding: "utf8", windowsHide: true, env }, (error, stdout) => {
      if (error) done(error.killed ? { kind: "timeout" } : failed(error));
      else done({ kind: "ok", stdout });
    });
  });
}

// 고정 loopback 주소만 조회한다. 설정에 적힌 외부 서버나 HTTP 프록시로 비밀을 전달하지 않는다.
export function readLocalJson({ port = 11434, path = "/api/tags", timeoutMs = TIMEOUT } = {}) {
  return new Promise((done) => {
    let settled = false;
    let timer;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); done(result); } };
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      if (res.statusCode !== 200) { finish({ kind: "failed" }); res.destroy(); return; }
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > LIMIT) { finish({ kind: "malformed" }); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on("error", () => finish({ kind: "failed" }));
      res.on("end", () => {
        try { finish({ kind: "ok", data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { finish({ kind: "malformed" }); }
      });
    });
    timer = setTimeout(() => { finish({ kind: "timeout" }); req.destroy(); }, timeoutMs);
    req.on("error", () => finish({ kind: "failed" }));
    req.end();
  });
}

async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work).catch(() => ({ kind: "failed" })),
      new Promise((done) => { timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function check(id, label, status, summary, action = "", details) {
  return { id, label, status, summary, ...(action ? { action } : {}), ...(details ? { details } : {}) };
}

function unavailable(id, label, result, action) {
  const kind = result?.kind;
  if (kind === "missing") return check(id, label, "blocked", "필요한 파일 또는 명령이 없습니다.", action);
  return check(id, label, "unknown", kind === "timeout" ? "제한 시간 안에 확인하지 못했습니다." : "응답을 신뢰할 수 없어 확인하지 못했습니다.", action);
}

// .env.local을 source하지 않는다. 정적인 단일행 값만 내부 비교에 쓰고, 보고서에는 변수명/존재 여부만 남긴다.
export function parseConfiguration(source) {
  const values = new Map();
  const unresolved = new Set();
  let invalidLines = 0;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) { invalidLines++; continue; }
    const [, name, raw] = match;
    values.delete(name); unresolved.delete(name);
    const token = raw.trim();
    const single = /^'([^']*)'\s*(?:#.*)?$/.exec(token);
    const double = /^"([^"\\$`]*)"\s*(?:#.*)?$/.exec(token);
    const plain = /^([^\s'"\\$`;|&<>]*)\s*(?:#.*)?$/.exec(token);
    if (single || double || plain) values.set(name, (single || double || plain)[1]);
    else unresolved.add(name);
  }
  return { values, unresolved, invalidLines };
}

function packageData(value) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.name === "string";
}

function dependencyNames(pkg) {
  const result = [];
  for (const group of [pkg.dependencies, pkg.devDependencies]) {
    if (group === undefined) continue;
    if (!group || typeof group !== "object" || Array.isArray(group)) return null;
    for (const [name, version] of Object.entries(group)) {
      if (!PACKAGE_NAME.test(name) || name.includes("..") || typeof version !== "string") return null;
      result.push(name);
    }
  }
  return [...new Set(result)].sort();
}

export async function runDoctor({ demo = false, root = ROOT, io = {}, timeoutMs = TIMEOUT + 500 } = {}) {
  const system = { nodeVersion: process.versions.node, platform: process.platform, env: process.env, home: homedir(), readFile, stat, realpath, command: readCommand, localJson: readLocalJson, ...io };
  const safe = async (fn) => {
    const result = await bounded(fn, timeoutMs);
    return result && typeof result === "object" && typeof result.kind === "string" ? result : { kind: "malformed" };
  };
  const file = (path) => safe(async () => {
    try {
      const info = await system.stat(path);
      if (!info.isFile() || info.size > LIMIT) return { kind: "malformed" };
      return { kind: "ok", text: await system.readFile(path, "utf8") };
    } catch (error) { return failed(error); }
  });
  const json = async (path) => {
    const result = await file(path);
    if (result.kind !== "ok") return result;
    try { return { kind: "ok", data: JSON.parse(result.text) }; } catch { return { kind: "malformed" }; }
  };
  const directory = (path) => safe(async () => {
    try { return { kind: "ok", exists: (await system.stat(path)).isDirectory() }; }
    catch (error) { return failed(error); }
  });
  const command = (args) => safe(() => system.command("docker", args, { timeoutMs: Math.min(timeoutMs, TIMEOUT), env: system.env }));
  const checks = [];
  const nodeMatch = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(system.nodeVersion ?? "");
  checks.push(check("node", "Node.js", !nodeMatch ? "unknown" : Number(nodeMatch[1]) >= 22 ? "ok" : "blocked", !nodeMatch ? "버전을 해석하지 못했습니다." : Number(nodeMatch[1]) >= 22 ? `Node ${system.nodeVersion}: 이 안내의 최소 버전을 충족합니다.` : "이 시작 안내에는 Node 22 이상이 필요합니다.", !nodeMatch || Number(nodeMatch[1]) < 22 ? "Node 22 이상을 직접 준비한 뒤 같은 명령을 다시 실행하세요. 원격 CI 검증 기준은 Node 22입니다." : ""));

  const manifest = await json(join(root, "package.json"));
  const validRoot = manifest.kind === "ok" && packageData(manifest.data) && manifest.data.name === "aios";
  const lock = await file(join(root, "pnpm-lock.yaml"));
  const workspace = await file(join(root, "pnpm-workspace.yaml"));
  checks.push(!validRoot ? unavailable("repository", "저장소 구성", manifest.kind === "ok" ? { kind: "malformed" } : manifest, "AIOS 저장소 전체를 복제했는지 확인하세요.") : lock.kind !== "ok" || workspace.kind !== "ok" ? unavailable("repository", "저장소 구성", lock.kind !== "ok" ? lock : workspace, "잠금 파일과 workspace 파일까지 포함하여 저장소를 다시 확인하세요.") : check("repository", "저장소 구성", "ok", "루트 package.json·잠금 파일·workspace 파일을 읽었습니다."));

  async function installedPnpm() {
    if (!validRoot || manifest.data.packageManager !== `pnpm@${PNPM_VERSION}`) return { kind: "malformed" };
    const candidates = [];
    // npm_execpath는 현재 pnpm run을 실행한 실제 패키지를 가리킨다. .bin에 있는 다른 pnpm을 잘못 고르지 않는다.
    if (system.env.npm_execpath) candidates.push(system.env.npm_execpath);
    for (const entry of (system.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const name of system.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm"] : ["pnpm"]) candidates.push(join(entry, name));
    }
    for (const candidate of candidates) {
      let actual;
      try { actual = await system.realpath(candidate); } catch { continue; }
      // 패키지 매니저를 실행하면 Corepack이 다운로드/캐시 생성을 할 수 있으므로 설치 메타데이터만 검사한다.
      let parent = dirname(actual);
      for (let depth = 0; depth < 4; depth++) {
        const pkg = await json(join(parent, "package.json"));
        if (pkg.kind === "ok" && pkg.data?.name === "pnpm" && /^\d+\.\d+\.\d+$/.test(pkg.data.version ?? "")) return { kind: "ok", version: pkg.data.version, source: "installed-package" };
        if (pkg.kind === "ok" && pkg.data?.name === "corepack") {
          const cache = system.env.COREPACK_HOME || join(system.env.XDG_CACHE_HOME || system.env.LOCALAPPDATA || join(system.home, system.platform === "win32" ? "AppData/Local" : ".cache"), "node/corepack");
          const cachedRoot = join(cache, "v1/pnpm", PNPM_VERSION);
          const cached = await json(join(cachedRoot, "package.json"));
          const metadata = await json(join(cachedRoot, ".corepack"));
          const binary = await file(join(cachedRoot, "bin/pnpm.cjs"));
          if (cached.kind === "ok" && cached.data?.name === "pnpm" && cached.data.version === PNPM_VERSION && metadata.kind === "ok" && metadata.data && typeof metadata.data === "object" && binary.kind === "ok") return { kind: "ok", version: PNPM_VERSION, source: "corepack-cache" };
          return { kind: "missing" };
        }
        const next = dirname(parent); if (next === parent) break; parent = next;
      }
      // 알 수 없는 shim을 건너뛰어 뒤쪽 pnpm으로 통과시키면 실제 선택된 명령과 달라진다.
      if (candidate !== system.env.npm_execpath) return { kind: "unrecognized" };
    }
    return { kind: "missing" };
  }
  const pnpm = await safe(installedPnpm);
  checks.push(pnpm.kind !== "ok" ? unavailable("pnpm", "pnpm", pnpm, "pnpm 9.12.0을 직접 준비하고 PATH를 확인하세요. 알 수 없는 shim/캐시는 실행하지 않았습니다. 이미 설치했다면 pnpm --version을 직접 확인하세요.") : check("pnpm", "pnpm", pnpm.version === PNPM_VERSION ? "ok" : "blocked", pnpm.version === PNPM_VERSION ? "설치 메타데이터에서 pnpm 9.12.0을 확인했습니다(실행 검증 아님)." : `선택된 설치 버전은 ${pnpm.version}이며 저장소 기준 9.12.0과 다릅니다.`, pnpm.version === PNPM_VERSION ? "" : "pnpm 9.12.0이 선택되도록 설치/PATH를 확인한 뒤 다시 검사하세요."));

  async function dependencies(id, label, base, pkg) {
    const names = dependencyNames(pkg);
    if (!names || !names.length) return check(id, label, "unknown", "의존성 목록을 확인할 수 없습니다.", "package.json의 의존성 목록을 확인하세요.");
    const results = await Promise.all(names.map(async (name) => {
      const result = await json(join(base, "node_modules", name, "package.json"));
      return { name, kind: result.kind === "ok" && (!packageData(result.data) || result.data.name !== name || typeof result.data.version !== "string") ? "malformed" : result.kind };
    }));
    const missing = results.filter((result) => result.kind === "missing").map((result) => result.name);
    const unknown = results.filter((result) => !["ok", "missing"].includes(result.kind)).map((result) => result.name);
    return check(id, label, unknown.length ? "unknown" : missing.length ? "blocked" : "ok", unknown.length ? "일부 설치 메타데이터를 읽거나 해석하지 못했습니다." : missing.length ? "필요한 의존성 설치가 누락되었습니다." : `${names.length}개 직접 의존성의 설치 메타데이터를 확인했습니다.`, missing.length || unknown.length ? "Node/pnpm을 준비한 뒤 저장소 루트에서 pnpm install --frozen-lockfile을 직접 실행하세요. 기존 설정은 덮어쓰지 마세요." : "", { missing, unknown });
  }
  checks.push(validRoot ? await dependencies("dependencies", "루트 의존성", root, manifest.data) : check("dependencies", "루트 의존성", "unknown", "유효한 루트 의존성 목록이 없습니다.", "저장소 구성을 먼저 확인하세요."));

  if (demo) {
    const demoRoot = join(root, "apps/demo");
    const pkg = await json(join(demoRoot, "package.json"));
    const valid = pkg.kind === "ok" && packageData(pkg.data) && pkg.data.name === "@aios/demo" && typeof pkg.data.scripts?.build === "string" && pkg.data.scripts.build.trim() && typeof pkg.data.scripts?.dev === "string" && pkg.data.scripts.dev.trim();
    checks.push(valid ? check("demo", "데모 앱", "ok", "@aios/demo의 dev/build 스크립트가 있습니다(빌드는 실행하지 않음).") : unavailable("demo", "데모 앱", pkg.kind === "ok" ? { kind: "malformed" } : pkg, "apps/demo가 포함된 최신 저장소인지 확인하세요."));
    checks.push(valid ? await dependencies("demo-dependencies", "데모 의존성", demoRoot, pkg.data) : check("demo-dependencies", "데모 의존성", "unknown", "데모의 의존성 목록을 확인할 수 없습니다.", "데모 앱 구성을 먼저 확인하세요."));
    return report("demo", checks);
  }

  checks.push(check("platform", "전체 로컬 앱 지원 범위", system.platform === "darwin" ? "ok" : "blocked", system.platform === "darwin" ? "현재 검증 대상인 macOS입니다." : "기존 전체 앱 시작기는 macOS/T7 전용이며 이 플랫폼의 설치를 지원하지 않습니다.", system.platform === "darwin" ? "" : "화면 체험은 --demo를 사용하세요. 전체 앱의 경로·샌드박스·서비스 이식은 별도 작업입니다."));
  const storage = await directory("/Volumes/T7");
  checks.push(storage.kind === "ok" && storage.exists ? check("t7", "T7 저장소", "ok", "/Volumes/T7 디렉터리가 있습니다(쓰기·용량 검사는 하지 않음).") : unavailable("t7", "T7 저장소", storage.kind === "ok" ? { kind: "missing" } : storage, "기존 T7를 연결하세요. 다른 경로에 빈 폴더를 만들어 통과시키지 마세요. 일반 PC 체험은 --demo를 사용하세요."));
  const paths = [["workspace", "/Volumes/T7/bigdata/workspaces/my-first-project"], ["models", "/Volumes/T7/bigdata/ollama-models"]];
  const pathResults = await Promise.all(paths.map(async ([name, path]) => ({ name, result: await directory(path) })));
  const unavailablePaths = pathResults.filter(({ result }) => result.kind !== "ok" || !result.exists);
  checks.push(check("local-directories", "기존 로컬 데이터 폴더", unavailablePaths.some(({ result }) => !["ok", "missing"].includes(result.kind)) ? "unknown" : unavailablePaths.length ? "blocked" : "ok", unavailablePaths.length ? "전용 작업 폴더 또는 모델 폴더를 확인하지 못했습니다." : "전용 작업 폴더와 모델 폴더가 있습니다(내용·권한은 미검증).", unavailablePaths.length ? "기존 Mac/T7 준비 안내를 확인하세요. 소스 복제에는 사용자 파일과 모델이 포함되지 않습니다." : "", { missing: unavailablePaths.map(({ name }) => name) }));

  const configFile = await file(join(root, ".env.local"));
  let config;
  if (configFile.kind === "ok") {
    config = parseConfiguration(configFile.text);
    const names = [...new Set([...config.values.keys(), ...config.unresolved])].sort();
    const missing = REQUIRED_CONFIG.filter((name) => !config.values.has(name) && !config.unresolved.has(name));
    const empty = [...config.values].filter(([, value]) => !value).map(([name]) => name).sort();
    const requiredEmpty = REQUIRED_CONFIG.filter((name) => empty.includes(name));
    const unknown = config.invalidLines > 0 || config.unresolved.size > 0;
    checks.push(check("configuration", "로컬 설정", missing.length || requiredEmpty.length ? "blocked" : unknown ? "unknown" : "ok", missing.length || requiredEmpty.length ? "필수 설정 변수가 없거나 비어 있습니다. 외부 AI 키는 필수가 아닙니다." : unknown ? "셸 표현식 또는 복잡한 설정 줄은 실행하지 않아 확인할 수 없습니다." : "필수 설정 변수의 정적인 비어 있지 않은 값이 있습니다(연결·인증 성공을 뜻하지 않음).", missing.length || requiredEmpty.length || unknown ? ".env.local을 직접 점검하세요. 필요한 변수는 DATABASE_URL, LOCAL_LLM_BASE_URL입니다. 기존 파일에 예제를 덮어쓰지 마세요." : "", { present: true, variables: names, missing, empty, unresolved: [...config.unresolved].sort() }));
  } else checks.push({ ...unavailable("configuration", "로컬 설정", configFile, ".env.local이 필요합니다. 기존 파일이 없을 때에만 .env.example을 참고해 직접 작성하세요. 키/DB/모델은 저장소에 포함되지 않습니다."), details: { present: configFile.kind === "missing" ? false : null, variables: [] } });

  const dockerChecks = async () => {
    const result = [];
    const cli = await command(["--version"]);
    const cliOk = cli?.kind === "ok" && /^Docker version \d+\.\d+(?:\.\d+)?(?:,|\s|$)/.test(cli.stdout?.trim() ?? "");
    result.push(cliOk ? check("docker-cli", "Docker CLI", "ok", "Docker CLI 버전 응답을 확인했습니다.") : unavailable("docker-cli", "Docker CLI", cli?.kind === "ok" ? { kind: "malformed" } : cli, "Docker CLI를 직접 설치하거나 PATH를 확인하세요. doctor는 설치하거나 엔진을 켜지 않습니다."));
    let engineOk = false;
    if (cliOk) {
      const context = system.env.DOCKER_HOST && !system.env.DOCKER_CONTEXT ? { kind: "ok", stdout: JSON.stringify(system.env.DOCKER_HOST) } : await command(["context", "inspect", "--format", '{{json (index .Endpoints "docker").Host}}']);
      let endpoint;
      try { endpoint = context.kind === "ok" ? JSON.parse(context.stdout) : null; } catch { /* 원격 경로나 원본 오류는 출력하지 않는다. */ }
      if (typeof endpoint !== "string" || !/^(unix|npipe):\/\//.test(endpoint)) result.push(check("docker-engine", "Docker 엔진", "unknown", "로컬 소켓 컨텍스트를 확인하지 못해 엔진 요청을 보내지 않았습니다.", "Docker의 현재 컨텍스트와 DOCKER_HOST/DOCKER_CONTEXT를 직접 확인하세요. 원격 Docker는 이 진단 범위 밖입니다."));
      else {
        const engine = await command(["info", "--format", "{{json .ServerVersion}}"]);
        let version;
        try { version = engine.kind === "ok" ? JSON.parse(engine.stdout) : null; } catch { /* 잘못된 응답은 unknown이다. */ }
        engineOk = typeof version === "string" && /^\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(version);
        result.push(engineOk ? check("docker-engine", "Docker 엔진", "ok", "로컬 Docker 엔진 응답을 확인했습니다.") : unavailable("docker-engine", "Docker 엔진", engine.kind === "ok" ? { kind: "malformed" } : engine, "사용 중인 Docker Desktop/Colima의 현재 상태를 직접 확인하세요. doctor는 기동하지 않습니다."));
      }
    } else result.push(check("docker-engine", "Docker 엔진", "unknown", "CLI를 확인하지 못해 엔진 상태도 미확인입니다.", "Docker CLI 문제부터 확인하세요."));
    for (const [id, label, container] of [["postgres", "Postgres 컨테이너", "1ai-postgres-1"], ["redis", "Redis 컨테이너", "1ai-redis-1"]]) {
      if (!engineOk) { result.push(check(id, label, "unknown", "엔진을 확인하지 못해 컨테이너 상태도 미확인입니다.", "Docker 엔진 확인 뒤 다시 실행하세요.")); continue; }
      const inspected = await command(["inspect", container, "--format", "{{json .State}}"]);
      let state;
      try { state = inspected.kind === "ok" ? JSON.parse(inspected.stdout) : null; } catch { /* raw inspect는 설정 값을 포함할 수 있으므로 출력하지 않는다. */ }
      if (!state || typeof state.Running !== "boolean" || typeof state.Status !== "string") result.push(unavailable(id, label, inspected.kind === "ok" ? { kind: "malformed" } : inspected, `docker compose -p 1ai ps에서 ${label} 존재/상태를 직접 확인하세요. 다른 프로젝트 컨테이너로 대체 판정하지 않습니다.`));
      else if (!state.Running || state.Status !== "running") result.push(check(id, label, "blocked", "전용 컨테이너가 실행 중이 아닙니다.", "기존 로컬 서비스 준비 방법을 확인하세요. doctor는 기동하지 않습니다."));
      else if (state.Health?.Status === "healthy") result.push(check(id, label, "ok", "전용 컨테이너가 실행 중이며 Docker healthcheck가 healthy입니다(앱 연결/스키마는 미검증)."));
      else result.push(check(id, label, state.Health?.Status === "unhealthy" || state.Health?.Status === "starting" ? "blocked" : "unknown", "컨테이너 실행만으로 DB/Redis 준비 완료를 판단할 수 없습니다.", "컨테이너 healthcheck와 앱 연결 설정을 직접 확인하세요."));
    }
    return result;
  };

  const ollamaChecks = async () => {
    const result = await safe(() => system.localJson({ timeoutMs: Math.min(timeoutMs, TIMEOUT) }));
    const valid = result?.kind === "ok" && Array.isArray(result.data?.models) && result.data.models.every((model) => model && typeof model.name === "string" && model.name.trim());
    if (!valid) return [unavailable("ollama", "Ollama 로컬 응답", result?.kind === "ok" ? { kind: "malformed" } : result, "로컬 Ollama 상태와 모델 저장 위치를 직접 확인하세요. doctor는 기동하거나 모델을 받지 않습니다."), check("models", "로컬 모델 준비", "unknown", "유효한 모델 목록이 없어 준비 여부를 판단하지 않았습니다.", "Ollama 응답 문제부터 확인하세요.")];
    const status = [check("ollama", "Ollama 로컬 응답", "ok", "고정 loopback Ollama 모델 목록 응답을 확인했습니다(추론 미실행).")];
    const base = config?.values.get("LOCAL_LLM_BASE_URL");
    let local = false;
    try { const url = new URL(base); local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "11434" && ["", "/", "/v1", "/v1/"].includes(url.pathname) && !url.username && !url.password && !url.search && !url.hash; } catch { /* 설정 값 자체는 출력하지 않는다. */ }
    if (!local || config?.unresolved.has("LOCAL_LLM_MODELS") || config?.unresolved.has("LOCAL_EMBED_MODEL")) { status.push(check("models", "로컬 모델 준비", "unknown", "설정된 모델/API 대상과 이 로컬 목록의 일치를 확인하지 못했습니다.", "LOCAL_LLM_BASE_URL, LOCAL_LLM_MODELS, LOCAL_EMBED_MODEL을 직접 확인하세요. 외부 주소에는 요청을 보내지 않았습니다.")); return status; }
    const chat = (config.values.get("LOCAL_LLM_MODELS") ?? "qwen3:8b").split(",").map((value) => value.trim()).filter(Boolean);
    const embedding = config.values.get("LOCAL_EMBED_MODEL") ?? "bge-m3";
    const names = new Set(result.data.models.map((model) => model.name));
    const available = (name) => names.has(name) || names.has(`${name}:latest`);
    const chatReady = chat.length > 0 && chat.every(available);
    const embeddingReady = Boolean(embedding) && available(embedding);
    status.push(check("models", "로컬 모델 준비", chatReady && embeddingReady ? "ok" : "blocked", chatReady && embeddingReady ? "설정된 대화/임베딩 모델이 로컬 목록에 있습니다(적재·품질·속도는 미검증)." : "대화 또는 임베딩 모델이 로컬 목록에 없습니다.", chatReady && embeddingReady ? "" : "LOCAL_LLM_MODELS, LOCAL_EMBED_MODEL과 T7의 모델 준비 상태를 직접 확인하세요. 모델 다운로드는 별도 용량/시간이 드는 수동 작업입니다.", { chatReady, embeddingReady }));
    return status;
  };
  const [docker, ollama] = await Promise.all([dockerChecks(), ollamaChecks()]);
  checks.push(...docker, ...ollama);
  return report("local", checks);
}

function report(mode, checks) {
  const ready = checks.length > 0 && checks.every((item) => item.status === "ok" || item.status === "warning");
  return { schemaVersion: 1, mode, ready, exitCode: ready ? 0 : 1, checks, limitations: mode === "demo" ? ["샘플/시뮬레이션 화면의 빌드 전제만 검사했습니다. 빌드·브라우저 동작은 실행하지 않았습니다.", "로컬 설정·T7·Docker·DB·Redis·Ollama는 데모에 필요하지 않아 검사하지 않았습니다."] : ["현재 전체 앱은 기존 macOS/T7 환경용입니다. 이 명령은 설치·기동·복구를 하지 않습니다.", "경로/설치 메타데이터/서비스 응답만 검사합니다. DB 스키마·인증·실제 AI 응답·작업 폴더 공유·파일 실행 안전성·백업 무결성은 별도 검증이 필요합니다.", "준비물 확인 결과이며 실행 중인 AIOS가 정상이라는 뜻이 아닙니다. 현재 앱 상태는 AIOS 상태 확인.command로 확인하세요."], privacy: "설정은 변수명과 존재/빈 값 여부만 표시합니다. 값·키·명령 원본 출력·예외 메시지는 포함하지 않습니다." };
}

export function formatReport(result) {
  const labels = { ok: "확인", warning: "권고", blocked: "준비 필요", unknown: "미확인" };
  const lines = [`AIOS 읽기 전용 준비 진단 — ${result.mode === "demo" ? "공개 체험 데모" : "기존 Mac/T7 전체 앱"}`, result.ready ? "검사한 준비물은 확인되었습니다. 실제 동작 검증은 별도입니다." : "준비가 부족하거나 확인하지 못한 항목이 있습니다. 자동 변경은 하지 않았습니다."];
  for (const item of result.checks) {
    lines.push(`\n[${labels[item.status] ?? "미확인"}] ${item.label}: ${item.summary}`);
    if (item.action) lines.push(`  다음: ${item.action}`);
    if (item.id === "configuration" && item.details?.variables?.length) lines.push(`  설정 변수명: ${item.details.variables.join(", ")}`);
    if (item.details?.missing?.length) lines.push(`  누락 항목: ${item.details.missing.join(", ")}`);
    if (item.details?.empty?.length) lines.push(`  빈 설정 변수명: ${item.details.empty.join(", ")}`);
  }
  lines.push("", ...result.limitations, result.privacy);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log("사용법: node scripts/doctor.mjs [--demo] [--json]\n기본: 기존 Mac/T7 전체 앱 준비물. --demo: 샘플 데모 빌드 전제만.\n읽기 전용이며 설치/기동/설정 변경/모델 호출을 하지 않습니다. 종료 코드: 0=검사한 준비물 확인, 1=준비 필요/미확인, 2=잘못된 인자/진단 내부 오류."); return 0; }
  if (argv.some((arg) => !["--demo", "--json"].includes(arg))) {
    const error = { schemaVersion: 1, ready: false, exitCode: 2, error: "지원하지 않는 인자입니다. --help로 사용법을 확인하세요." };
    console.log(argv.includes("--json") ? JSON.stringify(error) : error.error); return 2;
  }
  try {
    const result = await runDoctor({ demo: argv.includes("--demo") });
    console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatReport(result));
    return result.exitCode;
  } catch {
    const error = { schemaVersion: 1, ready: false, exitCode: 2, error: "진단을 완료하지 못했습니다. Node 버전·저장소 파일 접근 권한을 확인하고 다시 실행하세요. 설정이나 서비스는 변경하지 않았습니다." };
    console.log(argv.includes("--json") ? JSON.stringify(error) : error.error); return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
