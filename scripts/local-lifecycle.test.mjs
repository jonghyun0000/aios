import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquirePortLock, releasePortLock, assertStartAllowed, runtimePaths, processIdentity, matchesIdentity, inspectRuntime, stopRuntime, buildFingerprint, outputFingerprint, canReuseBuild } from "./local-lifecycle.mjs";

const temporaryRoot = "/Volumes/T7/bigdata/tests";
await mkdir(temporaryRoot, { recursive: true });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(temporaryRoot, "local-lifecycle-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const dir of ["scripts", "apps/api/dist", "apps/api/src", "apps/web/dist/assets", "apps/web/src", "packages/shared/src", "state"]) await mkdir(join(root, dir), { recursive: true });
  return root;
}

async function child(t, root, role) {
  const file = role === "launcher" ? "scripts/local-lifecycle.mjs" : `apps/api/dist/${role === "api" ? "main" : "worker"}.js`;
  const code = role === "api"
    ? `const http=require('node:http'); let ready=true; const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready}));});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));process.on('SIGUSR1',()=>{ready=false;process.send({degraded:true});});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`
    : role === "launcher" ? `setInterval(()=>{},1000);process.send({ready:true});process.on('SIGTERM',()=>process.send({stop:true}));process.on('message',m=>{if(m.exit)process.exit(0);});`
    : `setInterval(()=>{},1000);process.send({ready:true});process.on('SIGTERM',()=>process.exit(0));`;
  await writeFile(join(root, file), code);
  // launcher는 .mjs이므로 테스트 더블에도 require를 주입할 필요 없이 이 코드는 CJS API를 쓰지 않는다.
  const proc = spawn(process.execPath, [join(root, file), ...(role === "launcher" ? ["start"] : [])], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; proc.stderr.on("data", (chunk) => { errors += chunk; });
  const hello = await Promise.race([once(proc, "message").then(([message]) => message), once(proc, "exit").then(() => { throw new Error(errors || `${role} exited early`); })]);
  t.after(async () => { if (proc.exitCode === null && !proc.signalCode) { if (role === "launcher") proc.send({ exit: true }); else proc.kill("SIGTERM"); await once(proc, "exit"); } });
  return { proc, hello, identity: await processIdentity(proc.pid) };
}

async function runtimeFixture(t) {
  const root = await fixture(t);
  const api = await child(t, root, "api");
  const worker = await child(t, root, "worker");
  const launcher = await child(t, root, "launcher");
  const port = api.hello.port;
  const paths = runtimePaths(root, port, join(root, "state"));
  await mkdir(paths.directory, { recursive: true });
  const state = { schemaVersion: 1, instanceId: "fixture-instance", projectRoot: root, port, state: "ready", launcher: launcher.identity, children: { api: api.identity, worker: worker.identity }, message: "준비 완료" };
  const save = () => writeFile(paths.manifest, JSON.stringify(state));
  await save();
  return { root, paths, port, state, save, api, worker, launcher };
}

test("프로젝트 경로 유니코드 정규화 및 포트 범위", () => {
  assert.equal(runtimePaths("/Volumes/T7/한글", 8791).manifest, runtimePaths("/Volumes/T7/한글".normalize("NFD"), 8791).manifest);
  assert.throws(() => runtimePaths("/Volumes/T7/a", 80));
  assert.throws(() => runtimePaths("/Volumes/T7/a", "8791;bad"));
});

test("소스 같은 길이/시각 변경·추가·삭제·공용 패키지 결함을 실제 검출", async (t) => {
  const root = await fixture(t);
  const source = join(root, "apps/api/src/main.ts");
  await writeFile(source, "export const n=1;");
  const before = await buildFingerprint(root);
  const times = await stat(source);
  await writeFile(source, "export const n=2;"); await utimes(source, times.atime, times.mtime);
  assert.notEqual((await buildFingerprint(root)).inputHash, before.inputHash, "mtime/크기만 보던 결함 검출");
  await writeFile(source, "export const n=1;");
  assert.equal((await buildFingerprint(root)).inputHash, before.inputHash);
  const added = join(root, "packages/shared/src/add.ts"); await writeFile(added, "changed");
  assert.notEqual((await buildFingerprint(root)).inputHash, before.inputHash);
  await unlink(added); assert.equal((await buildFingerprint(root)).inputHash, before.inputHash);
  await writeFile(join(root, "apps/web/src/._sidecar"), "ignored"); assert.equal((await buildFingerprint(root)).inputHash, before.inputHash);
  await writeFile(join(root, ".env.local"), "SECRET=not-persisted"); assert.equal((await buildFingerprint(root)).inputHash, before.inputHash);
  await writeFile(join(root, "apps/web/.env.local"), "VITE_VALUE=private"); assert.equal((await buildFingerprint(root)).cacheable, false);
});

test("실제 산출물 변조·누락은 빌드 캐시를 무효화", async (t) => {
  const root = await fixture(t);
  for (const file of ["apps/api/dist/main.js", "apps/api/dist/worker.js", "apps/api/dist/bigdata-worker.js", "apps/web/dist/index.html", "apps/web/dist/assets/main.js"]) await writeFile(join(root, file), "original");
  const manifest = join(root, "state/build.json");
  await writeFile(manifest, JSON.stringify({ ...(await buildFingerprint(root)), outputHash: await outputFingerprint(root) }));
  assert.equal((await canReuseBuild(root, manifest)).reuse, true);
  await writeFile(join(root, "apps/web/dist/assets/main.js"), "tampered");
  assert.equal((await canReuseBuild(root, manifest)).reuse, false, "output을 검사하지 않던 결함 검출");
  await writeFile(join(root, "apps/web/dist/assets/main.js"), "original");
  assert.equal((await canReuseBuild(root, manifest)).reuse, true);
  await unlink(join(root, "apps/api/dist/worker.js")); assert.equal((await canReuseBuild(root, manifest)).reuse, false);
});

test("설치 의존성 내용이 같은 크기·mtime으로 변해도 검출", async (t) => {
  const root = await fixture(t);
  const dependency = join(root, "node_modules/example/index.js");
  await mkdir(join(root, "node_modules/example"), { recursive: true });
  await writeFile(dependency, "module.exports=1;");
  const before = await buildFingerprint(root); const times = await stat(dependency);
  await writeFile(dependency, "module.exports=2;"); await utimes(dependency, times.atime, times.mtime);
  assert.notEqual((await buildFingerprint(root)).inputHash, before.inputHash);
  await writeFile(dependency, "module.exports=1;"); assert.equal((await buildFingerprint(root)).inputHash, before.inputHash);
});

test("실제 PID의 생성시각·역할·프로젝트 불일치 거부", async (t) => {
  const root = await fixture(t);
  const worker = await child(t, root, "worker");
  assert.equal(await matchesIdentity(worker.identity, root, "worker"), true);
  assert.equal(await matchesIdentity({ ...worker.identity, startedAt: "reused-pid" }, root, "worker"), false);
  assert.equal(await matchesIdentity(worker.identity, root, "api"), false);
  assert.equal(await matchesIdentity(worker.identity, join(root, "other-project"), "worker"), false);
});

test("동시 시작 3개 중 하나만 잠금 소유·남의 잠금 해제 금지", async (t) => {
  const root = await fixture(t);
  const launcher = await child(t, root, "launcher");
  const paths = runtimePaths(root, 64987, join(root, "state"));
  const owners = [1, 2, 3].map((n) => ({ projectRoot: root, port: 64987, instanceId: `start-${n}`, launcher: launcher.identity }));
  const results = await Promise.allSettled(owners.map((owner) => acquirePortLock(paths, owner)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const owned = JSON.parse(await readFile(paths.lock, "utf8"));
  await releasePortLock(paths, "not-owner"); assert.equal(JSON.parse(await readFile(paths.lock, "utf8")).instanceId, owned.instanceId);
  await releasePortLock(paths, owned.instanceId); await assert.rejects(readFile(paths.lock));
});

test("죽은 PID 잠금 회수·깨진 잠금은 자동 삭제하지 않음", async (t) => {
  const root = await fixture(t);
  const launcher = await child(t, root, "launcher");
  const paths = runtimePaths(root, 64988, join(root, "state"));
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ projectRoot: root, port: 64988, instanceId: "old", launcher: { ...launcher.identity, pid: 99999999 } }));
  const owner = { projectRoot: root, port: 64988, instanceId: "new", launcher: launcher.identity };
  await acquirePortLock(paths, owner); assert.equal(JSON.parse(await readFile(paths.lock, "utf8")).instanceId, "new");
  await releasePortLock(paths, "new"); await writeFile(paths.lock, "{");
  await assert.rejects(acquirePortLock(paths, owner), /상태 파일/);
  assert.equal(await readFile(paths.lock, "utf8"), "{");
});

test("기록 없는 포트 충돌은 상태/종료 모두 거부하고 서버 보존", async (t) => {
  const root = await fixture(t);
  const server = createServer((_req, response) => response.end("unrelated"));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const port = server.address().port;
  const paths = runtimePaths(root, port, join(root, "state"));
  await assert.rejects(assertStartAllowed(paths, port), /다른 프로그램/);
  assert.equal((await inspectRuntime(root, port, paths)).state, "conflict");
  assert.equal((await stopRuntime(root, port, paths)).exitCode, 2);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "unrelated");
});

test("유지보수 잠금은 시작을 거부하며 잠금/이전 기록은 보존", async (t) => {
  const root = await fixture(t);
  const paths = runtimePaths(root, 64986, join(root, "state"));
  await mkdir(paths.directory, { recursive: true });
  await mkdir(paths.maintenance); await writeFile(paths.manifest, '{"state":"stopped"}');
  await assert.rejects(assertStartAllowed(paths, 64986), /유지보수/);
  assert.equal((await stat(paths.maintenance)).isDirectory(), true);
  assert.equal(await readFile(paths.manifest, "utf8"), '{"state":"stopped"}');
});

test("ready 기록이 있어도 실제 워커 사망을 검출", async (t) => {
  const f = await runtimeFixture(t);
  assert.equal((await inspectRuntime(f.root, f.port, f.paths)).healthy, true);
  f.worker.proc.kill("SIGTERM"); await once(f.worker.proc, "exit");
  const observed = await inspectRuntime(f.root, f.port, f.paths);
  assert.equal(observed.state, "failed"); assert.equal(observed.healthy, false); assert.equal(observed.workerAlive, false);
  assert.match(observed.message, /정상적이지/);
});

test("HTTP 200이어도 ready:false를 검출·유지보수 상태 표시", async (t) => {
  const f = await runtimeFixture(t);
  assert.equal((await inspectRuntime(f.root, f.port, f.paths)).healthy, true);
  f.api.proc.kill("SIGUSR1"); await once(f.api.proc, "message");
  assert.equal((await inspectRuntime(f.root, f.port, f.paths)).healthy, false);
  await mkdir(f.paths.maintenance);
  assert.equal((await inspectRuntime(f.root, f.port, f.paths)).maintenance, true);
});

test("PID 재사용을 주입해 종료 신호가 전달되지 않음을 검증", async (t) => {
  const f = await runtimeFixture(t);
  f.state.launcher.startedAt = "stale start time"; await f.save();
  let signalled = false; f.launcher.proc.on("message", (message) => { if (message.stop) signalled = true; });
  assert.equal((await stopRuntime(f.root, f.port, f.paths)).exitCode, 2);
  await delay(100); assert.equal(signalled, false);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/readyz`)).ok, true);
});

test("정확한 감독자만 TERM 수신·자식/포트 종료를 확인한 후 성공", async (t) => {
  const f = await runtimeFixture(t);
  let requested = false;
  const completion = new Promise((accept, reject) => {
    f.launcher.proc.once("message", async (message) => {
      try {
        assert.equal(message.stop, true); requested = true;
        const closed = [once(f.api.proc, "exit"), once(f.worker.proc, "exit")];
        f.api.proc.kill("SIGTERM"); f.worker.proc.kill("SIGTERM"); await Promise.all(closed);
        f.state.state = "stopped"; f.state.message = "종료 완료"; await f.save();
        f.launcher.proc.send({ exit: true }); accept();
      } catch (error) { reject(error); }
    });
  });
  const outcome = await stopRuntime(f.root, f.port, f.paths); await completion;
  assert.equal(outcome.exitCode, 0); assert.equal(requested, true);
  assert.equal((await inspectRuntime(f.root, f.port, f.paths)).state, "stopped");
});
