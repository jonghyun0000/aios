import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatReport, parseConfiguration, readCommand, readLocalJson, runDoctor } from "./doctor.mjs";

// 파일을 실제 생성하지 않는 더블이므로 Linux CI에서도 기존 T7/비밀/서비스를 건드리지 않는다.
function fixture() {
  const root = "/fixture/aios";
  const files = new Map([
    [join(root, "package.json"), JSON.stringify({ name: "aios", packageManager: "pnpm@9.12.0", devDependencies: { typescript: "^5.6.2", turbo: "^2.1.0" } })],
    [join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'"],
    [join(root, "pnpm-workspace.yaml"), "packages: ['apps/*']"],
    [join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "5.6.2" })],
    [join(root, "node_modules/turbo/package.json"), JSON.stringify({ name: "turbo", version: "2.1.0" })],
    [join(root, "apps/demo/package.json"), JSON.stringify({ name: "@aios/demo", scripts: { dev: "vite", build: "tsc --noEmit && vite build" }, dependencies: { react: "^18.3.1" }, devDependencies: { vite: "^5.4.11" } })],
    [join(root, "apps/demo/node_modules/react/package.json"), JSON.stringify({ name: "react", version: "18.3.1" })],
    [join(root, "apps/demo/node_modules/vite/package.json"), JSON.stringify({ name: "vite", version: "5.4.11" })],
    [join(root, ".env.local"), "DATABASE_URL=postgres://local:secret-canary@localhost:5432/aios\nLOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\nOPENAI_API_KEY=super-secret-canary\n"],
    ["/tools/pnpm/package.json", JSON.stringify({ name: "pnpm", version: "9.12.0" })],
  ]);
  const dirs = new Set(["/Volumes/T7", "/Volumes/T7/bigdata/workspaces/my-first-project", "/Volumes/T7/bigdata/ollama-models"]);
  const calls = [];
  const missing = () => { const error = new Error("secret-canary must not escape"); error.code = "ENOENT"; return error; };
  const io = {
    nodeVersion: "22.18.0", platform: "darwin", env: { PATH: "/tools/bin" }, home: "/fixture/home",
    async stat(path) { calls.push(["stat", path]); if (!files.has(path) && !dirs.has(path)) throw missing(); return { isFile: () => files.has(path), isDirectory: () => dirs.has(path), size: files.has(path) ? Buffer.byteLength(files.get(path)) : 0 }; },
    async readFile(path) { calls.push(["read", path]); if (!files.has(path)) throw missing(); return files.get(path); },
    async realpath(path) { calls.push(["realpath", path]); if (path === "/tools/bin/pnpm") return "/tools/pnpm/bin/pnpm.cjs"; throw missing(); },
    async command(command, args) {
      calls.push([command, ...args]);
      if (command !== "docker") throw new Error("설치/실행 명령을 호출하면 안 됨");
      if (args[0] === "--version") return { kind: "ok", stdout: "Docker version 28.3.2, build fixture" };
      if (args[0] === "context") return { kind: "ok", stdout: JSON.stringify("unix:///fixture/docker.sock") };
      if (args[0] === "info") return { kind: "ok", stdout: JSON.stringify("28.3.2") };
      if (args[0] === "inspect") return { kind: "ok", stdout: JSON.stringify({ Running: true, Status: "running", Health: { Status: "healthy" } }) };
      throw new Error("쓰기 명령은 허용하지 않는다");
    },
    async localJson() { calls.push(["ollama"]); return { kind: "ok", data: { models: [{ name: "qwen3:8b" }, { name: "bge-m3:latest" }] } }; },
  };
  return { root, files, dirs, calls, io, run: (options = {}) => runDoctor({ root, io, ...options }) };
}

const status = (report, id) => report.checks.find((item) => item.id === id)?.status;

test("준비물 정상 더블: 정확히 14개 검사, 비밀 값은 JSON/사람용 출력 모두 제외", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.ready, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.length, 14);
  assert.ok(result.checks.every((item) => item.status === "ok"));
  assert.ok(result.checks.find((item) => item.id === "configuration").details.variables.includes("OPENAI_API_KEY"));
  const output = JSON.stringify(result) + formatReport(result);
  assert.doesNotMatch(output, /secret-canary|postgres:\/\/|http:\/\/127\.0\.0\.1/);
  assert.match(output, /추론 미실행/);
  assert.ok(f.calls.filter(([kind]) => kind === "docker").every(([, command]) => ["--version", "context", "info", "inspect"].includes(command)));
});

test("T7 미연결 및 비macOS는 전체앱 준비 완료가 아니다", async () => {
  const f = fixture();
  f.dirs.delete("/Volumes/T7"); f.io.platform = "linux";
  const result = await f.run();
  assert.equal(result.ready, false); assert.equal(result.exitCode, 1);
  assert.equal(status(result, "t7"), "blocked"); assert.equal(status(result, "platform"), "blocked");
});

test("설정 필수 변수 누락/빈 값 검출: 외부 모델 키 부재는 필수 오류가 아니다", async () => {
  const f = fixture();
  const path = join(f.root, ".env.local");
  f.files.set(path, "LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\n");
  let result = await f.run();
  assert.equal(status(result, "configuration"), "blocked");
  assert.deepEqual(result.checks.find((item) => item.id === "configuration").details.missing, ["DATABASE_URL"]);
  f.files.set(path, "DATABASE_URL=\nLOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\n");
  result = await f.run(); assert.equal(status(result, "configuration"), "blocked");
  f.files.set(path, "DATABASE_URL=postgres://local:canary@localhost:5432/aios\nLOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\n");
  assert.equal((await f.run()).ready, true);
});

test("설정은 실행하지 않으며 셸 치환/중복 변수/이상한 줄은 보수적으로 처리", async () => {
  const parsed = parseConfiguration("A=old\nexport A='safe value' # comment\nB=$(touch secret-canary)\nC=\"$SECRET\"\nD=\"literal\"\nbad line\n");
  assert.equal(parsed.values.get("A"), "safe value"); assert.equal(parsed.values.get("D"), "literal");
  assert.deepEqual([...parsed.unresolved], ["B", "C"]); assert.equal(parsed.invalidLines, 1);
  const f = fixture();
  f.files.set(join(f.root, ".env.local"), "DATABASE_URL=$(touch secret-canary)\nLOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1\n");
  const result = await f.run(); assert.equal(status(result, "configuration"), "unknown"); assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result) + formatReport(result), /touch|secret-canary/);
});

test("Docker 미설치 결함: 엔진/DB/Redis가 확인으로 둔갑하지 않음", async () => {
  const f = fixture(); let commands = 0;
  f.io.command = async () => { commands++; return { kind: "missing", stderr: "secret-canary" }; };
  const result = await f.run();
  assert.equal(status(result, "docker-cli"), "blocked");
  for (const id of ["docker-engine", "postgres", "redis"]) assert.equal(status(result, id), "unknown");
  assert.equal(commands, 1); assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-canary/);
});

test("Docker 엔진 timeout/원본 오류/누락 응답을 실패 폐쇄", async () => {
  for (const defect of [{ kind: "timeout" }, { kind: "failed", stderr: "secret-canary" }, undefined]) {
    const f = fixture(); const original = f.io.command;
    f.io.command = async (cmd, args) => args[0] === "info" ? defect : original(cmd, args);
    const result = await f.run();
    assert.equal(result.ready, false); assert.equal(status(result, "docker-engine"), "unknown");
    assert.equal(status(result, "postgres"), "unknown"); assert.doesNotMatch(JSON.stringify(result), /secret-canary/);
  }
});

test("원격 Docker 컨텍스트에는 엔진/컨테이너 요청을 보내지 않음", async () => {
  const f = fixture();
  f.io.env.DOCKER_HOST = "tcp://private-secret-canary:2376";
  const result = await f.run();
  assert.equal(status(result, "docker-engine"), "unknown"); assert.equal(result.ready, false);
  assert.equal(f.calls.filter(([kind, arg]) => kind === "docker" && ["info", "inspect"].includes(arg)).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-secret-canary/);
});

test("DB는 Running만으로 통과하지 않음: health 누락/unhealthy/정지/손상 검출", async () => {
  for (const [state, expected] of [[{ Running: true, Status: "running" }, "unknown"], [{ Running: true, Status: "running", Health: { Status: "unhealthy" } }, "blocked"], [{ Running: false, Status: "exited" }, "blocked"], [{ Error: "secret-canary" }, "unknown"]]) {
    const f = fixture(); const original = f.io.command;
    f.io.command = async (cmd, args) => args[0] === "inspect" ? { kind: "ok", stdout: JSON.stringify(state) } : original(cmd, args);
    const result = await f.run(); assert.equal(status(result, "postgres"), expected); assert.equal(status(result, "redis"), expected); assert.equal(result.ready, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-canary/);
  }
});

test("Ollama malformed/누락 응답/빈 모델 목록/임베딩 누락 검출", async () => {
  for (const [response, expected] of [[{ kind: "ok", data: {} }, "unknown"], [{ kind: "ok", data: { models: [{ wrong: "secret-canary" }] } }, "unknown"], [undefined, "unknown"], [{ kind: "ok", data: { models: [] } }, "blocked"], [{ kind: "ok", data: { models: [{ name: "qwen3:8b" }] } }, "blocked"]]) {
    const f = fixture(); f.io.localJson = async () => response;
    const result = await f.run(); assert.equal(status(result, "models"), expected); assert.equal(result.ready, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-canary/);
  }
});

test("설정의 별도 모델/외부 API를 기본 로컬 모델과 잘못 동일시하지 않음", async () => {
  const f = fixture(); const path = join(f.root, ".env.local");
  f.files.set(path, f.files.get(path) + "LOCAL_LLM_MODELS=private-secret-canary\n");
  let result = await f.run(); assert.equal(status(result, "models"), "blocked");
  assert.doesNotMatch(JSON.stringify(result), /private-secret-canary/);
  f.files.set(path, "DATABASE_URL=postgres://local:secret-canary@localhost/aios\nLOCAL_LLM_BASE_URL=https://private-secret-canary.example/v1\n");
  result = await f.run(); assert.equal(status(result, "models"), "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private-secret-canary/);
});

test("의존성/잠금 파일/Node/pnpm/데모 앱 결함 각각 검출", async () => {
  for (const id of ["dependencies", "repository", "node", "pnpm", "demo", "demo-dependencies"]) {
    const f = fixture();
    if (id === "dependencies") f.files.delete(join(f.root, "node_modules/turbo/package.json"));
    if (id === "repository") f.files.delete(join(f.root, "pnpm-lock.yaml"));
    if (id === "node") f.io.nodeVersion = "20.11.0";
    if (id === "pnpm") f.files.set("/tools/pnpm/package.json", JSON.stringify({ name: "pnpm", version: "9.15.9" }));
    if (id === "demo") f.files.set(join(f.root, "apps/demo/package.json"), "{}");
    if (id === "demo-dependencies") f.files.delete(join(f.root, "apps/demo/node_modules/vite/package.json"));
    const result = await f.run({ demo: true });
    assert.equal(result.ready, false, id); assert.ok(["blocked", "unknown"].includes(status(result, id)), id);
  }
});

test("데모 모드는 Linux/DB/모델/T7/설정 부재에도 로컬 전용 검사를 호출하지 않음", async () => {
  const f = fixture(); f.io.platform = "linux"; f.dirs.clear(); f.files.delete(join(f.root, ".env.local"));
  f.io.command = async () => { assert.fail("데모에서 Docker 실행 금지"); };
  f.io.localJson = async () => { assert.fail("데모에서 Ollama 실행 금지"); };
  const result = await f.run({ demo: true });
  assert.equal(result.ready, true); assert.equal(result.checks.length, 6);
  assert.ok(!f.calls.some(([kind, path]) => ["read", "stat"].includes(kind) && (path.startsWith("/Volumes/T7") || path.endsWith(".env.local"))));
});

test("Corepack은 이미 설치된 캐시만 읽고 미설치/알 수 없는 shim은 실행하지 않음", async () => {
  const f = fixture();
  f.io.realpath = async () => "/tools/corepack/shims/pnpm";
  f.files.set("/tools/corepack/package.json", JSON.stringify({ name: "corepack", version: "0.33.0" }));
  const cache = "/fixture/home/.cache/node/corepack/v1/pnpm/9.12.0";
  let result = await f.run({ demo: true }); assert.equal(status(result, "pnpm"), "blocked");
  f.files.set(join(cache, "package.json"), JSON.stringify({ name: "pnpm", version: "9.12.0" }));
  f.files.set(join(cache, ".corepack"), JSON.stringify({ bin: ["pnpm"] }));
  f.files.set(join(cache, "bin/pnpm.cjs"), "// installed fixture");
  result = await f.run({ demo: true }); assert.equal(status(result, "pnpm"), "ok");
  f.io.realpath = async () => "/tools/custom/shim";
  result = await f.run({ demo: true }); assert.equal(status(result, "pnpm"), "unknown");
  assert.ok(!f.calls.some(([kind]) => kind === "pnpm"));
});

test("응답 없는 주입 probe도 제한 시간 안에 unknown으로 종료", async () => {
  const f = fixture(); f.io.command = () => new Promise(() => {}); f.io.localJson = () => new Promise(() => {});
  const started = performance.now(); const result = await f.run({ timeoutMs: 40 });
  assert.ok(performance.now() - started < 1200);
  assert.equal(status(result, "docker-cli"), "unknown"); assert.equal(status(result, "ollama"), "unknown"); assert.equal(result.exitCode, 1);
});

test("실제 자식 명령 timeout: 검사 전용 무한 프로세스를 제한 시간에 종료", async () => {
  const started = performance.now();
  const result = await readCommand(process.execPath, ["-e", "process.stderr.write('secret-canary');setInterval(()=>{},1000)"], { timeoutMs: 80 });
  assert.equal(result.kind, "timeout"); assert.ok(performance.now() - started < 1500); assert.doesNotMatch(JSON.stringify(result), /secret-canary/);
  assert.equal((await readCommand("/definitely-missing-aios-doctor-command", [])).kind, "missing");
});

test("실제 loopback HTTP malformed/응답 본문 정지 timeout 검출", async (t) => {
  const server = createServer((req, res) => { res.writeHead(200); if (req.url === "/malformed") res.end("not json secret-canary"); else res.write("{"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  assert.equal((await readLocalJson({ port, path: "/malformed", timeoutMs: 200 })).kind, "malformed");
  const started = performance.now();
  assert.equal((await readLocalJson({ port, path: "/hung", timeoutMs: 70 })).kind, "timeout");
  assert.ok(performance.now() - started < 1500);
});

test("CLI 잘못된 인자는 JSON만 출력하며 입력 원문을 반사하지 않음", async () => {
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./doctor.mjs", import.meta.url)), "--json", "--secret-canary"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; }); proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(proc, "close");
  assert.equal(code, 2); assert.equal(JSON.parse(stdout).ready, false); assert.equal(stderr, ""); assert.doesNotMatch(stdout, /secret-canary/);
});
