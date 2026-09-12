import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { get as httpGet } from "node:http";

const exec = promisify(execFile);
const base = "http://127.0.0.1:8791";
for (const headers of [{ origin: "https://untrusted.example" }, { host: "untrusted.example:8791" }]) {
  // fetch는 Host를 URL의 호스트로 대체할 수 있으므로 실제 HTTP 헤더를 보내는 API를 쓴다.
  const status = await new Promise((resolve, reject) => {
    httpGet(base + "/v1/me", { headers }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(status, 401);
}
console.log("PASS: 외부 Origin 및 DNS rebinding Host 거부");
const { stdout } = await exec("lsof", ["-t", "-iTCP:8791", "-sTCP:LISTEN"]);
const apiPid = Number(stdout.trim());
assert.ok(Number.isInteger(apiPid) && apiPid > 1);
const first = await fetch(base + "/v1/bigdata/categories").then(r => r.json());
assert.ok(first.categories.length > 0);
for (let round = 1; round <= 3; round++) {
  const { stdout: processes } = await exec("ps", ["-Ao", "pid,ppid,args"]);
  const children = processes.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(m => m && Number(m[2]) === apiPid && m[3].endsWith("/bigdata-worker.js"));
  assert.equal(children.length, 1, "검증 중인 로컬 API의 통계 자식만 종료할 수 있음");
  process.kill(Number(children[0][1]), "SIGKILL");
  await delay(200);
  const health = await fetch(base + "/healthz");
  assert.equal(health.status, 200, "통계 엔진이 죽어도 웹 서버는 생존해야 함");
  const restored = await fetch(base + "/v1/bigdata/categories");
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json()).categories, first.categories);
  process.kill(apiPid, 0);
  console.log(`PASS: 통계 엔진 강제 종료 ${round}/3 — 같은 API 프로세스 생존·재조회 복구`);
}
