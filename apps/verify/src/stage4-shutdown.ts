/** 두 실제 협업 피어의 마지막 편집 직후 사용자 종료 명령을 실행하는 독점 통합 검사. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import pg from "pg";

const exec = promisify(execFile);
const BASE = "http://127.0.0.1:8791";
const repo = await realpath(resolve(import.meta.dirname, "../../.."));
type Identity = { pid: number; startedAt: string; command: string; cwd: string };
type Runtime = { state: string; healthy: boolean; manifestPath: string; logsPath: string };
const lifecycle = await import(pathToFileURL(join(repo, "scripts/local-lifecycle.mjs")).href) as {
  inspectRuntime(root: string, port: number): Promise<Runtime>;
  processIdentity(pid: number): Promise<Identity | null>;
  matchesIdentity(identity: Identity, root: string, role: string): Promise<boolean>;
  listeningPids(port: number): Promise<number[]>;
};
class CheckError extends Error {}
const docName = `stage4-shutdown-${randomUUID()}`;
const report: {
  version: number; startedAt: string; document: string; status: "running" | "passed" | "failed";
  checks: { name: string; passed: boolean }[]; observations: Record<string, unknown>; error?: string;
} = { version: 1, startedAt: new Date().toISOString(), document: docName, status: "running", checks: [], observations: {} };
function check(name: string, condition: unknown): asserts condition {
  report.checks.push({ name, passed: Boolean(condition) });
  if (!condition) throw new CheckError(name);
}
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await delay(25); }
  throw new CheckError(`${label}: 시간 초과`);
}

class Peer {
  readonly doc = new Y.Doc();
  synced = false;
  private ws: WebSocket | null = null;
  private failure: Error | null = null;
  text(): string { return this.doc.getText("body").toJSON(); }
  assertHealthy(): void { if (this.failure) throw this.failure; }
  async connect(): Promise<void> {
    const ws = this.ws = new WebSocket(`${BASE.replace("http:", "ws:")}/v1/collab?doc=${encodeURIComponent(docName)}`, { origin: BASE });
    ws.binaryType = "arraybuffer";
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || ws.readyState !== WebSocket.OPEN) return;
      const message = encoding.createEncoder(); encoding.writeVarUint(message, 0); syncProtocol.writeUpdate(message, update);
      ws.send(encoding.toUint8Array(message));
    });
    ws.on("error", () => { this.failure = new CheckError("협업 소켓 오류"); });
    ws.on("message", (data: ArrayBuffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) !== 0) return;
        const response = encoding.createEncoder(); encoding.writeVarUint(response, 0);
        syncProtocol.readSyncMessage(decoder, response, this.doc, "remote");
        if (encoding.length(response) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(response));
        this.synced = true;
      } catch { this.failure = new CheckError("협업 프레임 해석 실패"); }
    });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new CheckError("협업 연결 시간 초과")), 10_000);
      ws.once("open", () => { clearTimeout(timer); done(); });
      ws.once("error", () => { clearTimeout(timer); fail(new CheckError("협업 연결 실패")); });
      ws.once("close", () => { clearTimeout(timer); fail(new CheckError("협업 연결이 먼저 닫힘")); });
    });
  }
  async close(): Promise<void> {
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>((done) => {
      const timer = setTimeout(() => { ws.terminate(); done(); }, 2000);
      ws.once("close", () => { clearTimeout(timer); done(); }); ws.close();
    });
    this.doc.destroy();
  }
}

const peers = [new Peer(), new Peer()];
let db: pg.Client | null = null;
let phase = "ready";
try {
  await waitFor(async () => {
    try { const r = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(2000) }); return r.ok && (await r.json() as { ready?: boolean }).ready === true; }
    catch { return false; }
  }, 120_000, "8791 준비");
  const runtime = await lifecycle.inspectRuntime(repo, 8791);
  check("관리 중인 API·워커가 준비됨", runtime.state === "ready" && runtime.healthy);
  const manifest = JSON.parse(await readFile(runtime.manifestPath, "utf8")) as { children: { api: Identity; worker: Identity }; instanceId: string };
  const api = manifest.children.api; const worker = manifest.children.worker;
  check("API·워커의 프로세스 신원 일치", await lifecycle.matchesIdentity(api, repo, "api") && await lifecycle.matchesIdentity(worker, repo, "worker"));
  report.observations.managedPids = { api: api.pid, worker: worker.pid };
  report.observations.instanceId = manifest.instanceId;
  const meResponse = await fetch(`${BASE}/v1/me`, { signal: AbortSignal.timeout(5000) });
  const me = await meResponse.json() as { orgId?: string; via?: string; role?: string };
  check("로컬 owner 조직 확인", meResponse.ok && me.via === "local" && me.role === "owner" && typeof me.orgId === "string");
  check("DB 환경 설정 존재", typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0);
  db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 10_000, application_name: "aios-stage4-shutdown" });
  await db.connect();
  const savedText = async (): Promise<string | null> => {
    const rows = await db!.query<{ state: Buffer }>("select state from collab_docs where org_id = $1 and doc_id = $2", [me.orgId, `${me.orgId}:${docName}`]);
    if (!rows.rows[0]) return null;
    const restored = new Y.Doc();
    try { Y.applyUpdate(restored, rows.rows[0].state); return restored.getText("body").toJSON(); }
    finally { restored.destroy(); }
  };
  check("기존 문서와 충돌하지 않는 신규 표본", await savedText() === null);
  phase = "websocket-edit";
  await Promise.all(peers.map((peer) => peer.connect()));
  await waitFor(() => { peers.forEach((p) => p.assertHealthy()); return peers.every((p) => p.synced); }, 10_000, "두 피어 초기 동기화");
  const first = peers[0]!; const second = peers[1]!;
  const baseline = `초기 저장 ${docName}\n`;
  first.doc.getText("body").insert(0, baseline);
  await waitFor(() => { second.assertHealthy(); return second.text() === baseline; }, 5000, "첫 편집 피어 전파");
  await waitFor(async () => await savedText() === baseline, 10_000, "초기 상태 실제 DB 저장");
  check("초기 편집이 다른 피어와 DB에 저장됨", second.text() === baseline && await savedText() === baseline);

  // 초기 상태를 실제로 저장한 뒤 새 편집을 넣는다. 종료 후 옛 스냅샷이 남는 결함을 구별한다.
  const logPath = join(runtime.logsPath, "api.log");
  const logOffset = (await stat(logPath)).size;
  const marker = `종료 직전 편집 ${randomUUID()}\n`;
  const expected = baseline + marker;
  const editedAt = Date.now();
  second.doc.getText("body").insert(baseline.length, marker);
  await waitFor(() => { first.assertHealthy(); return first.text() === expected; }, 1000, "마지막 편집 반대 피어 수신");
  const receivedAt = Date.now();
  check("마지막 편집의 피어 전파 확인", first.text() === expected && second.text() === expected);
  check("종료 직전에는 마지막 편집이 아직 DB에 없음", await savedText() === baseline);
  const stopCalledAt = Date.now();
  check("디바운스 2초 전에 실제 종료 명령 시작", stopCalledAt - editedAt < 2000);
  phase = "actual-stop-command";
  await exec("bash", [join(repo, "scripts/stop-local.sh")], { cwd: repo, env: { ...process.env, AIOS_LOCAL_PORT: "8791" }, timeout: 55_000, maxBuffer: 64 * 1024 });
  check("실제 종료 명령 종료 코드 0", true);
  report.observations.stopExitCode = 0;
  report.observations.editToPeerMs = receivedAt - editedAt;
  report.observations.editToStopCommandMs = stopCalledAt - editedAt;

  // 명령 실행 시각만으로 SIGTERM 시각을 추정하지 않는다. 해당 API PID의 실제 로그를 확인한다.
  const log = await open(logPath, "r");
  let signalAt: number | undefined;
  try {
    const bytes = Buffer.alloc(256 * 1024); const { bytesRead } = await log.read(bytes, 0, bytes.length, logOffset);
    for (const line of bytes.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as { pid?: number; time?: number; msg?: string; signal?: string };
        if (entry.pid === api.pid && entry.msg === "shutting down" && entry.signal === "SIGTERM" && typeof entry.time === "number" && entry.time >= editedAt) signalAt = entry.time;
      } catch { /* 다른 로그 행은 검사 결과로 인용하지 않는다. */ }
    }
  } finally { await log.close(); }
  check("디바운스 전에 API가 SIGTERM을 실제 수신", signalAt !== undefined && signalAt - editedAt < 2000);
  report.observations.editToApiSignalMs = signalAt - editedAt;
  phase = "persisted-after-stop";
  check("종료 후 실제 Yjs DB 스냅샷에 마지막 편집 보존", await savedText() === expected);
  const listeners = await lifecycle.listeningPids(8791);
  check("종료 후 8791 리스너 없음", listeners.length === 0);
  check("동일 관리 API·워커 프로세스 없음", await lifecycle.processIdentity(api.pid) === null && await lifecycle.processIdentity(worker.pid) === null);
  const after = JSON.parse(await readFile(runtime.manifestPath, "utf8")) as { state?: string; instanceId?: string; exitCode?: number };
  check("동일 실행의 정상 종료 기록", after.instanceId === manifest.instanceId && after.state === "stopped" && after.exitCode === 0);
  report.status = "passed";
} catch (error: unknown) {
  report.status = "failed";
  report.error = error instanceof CheckError ? error.message : `${phase} 검사 실패 (비밀 보호를 위해 원문 오류 생략)`;
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map((peer) => peer.close()));
  if (db) await db.end().catch(() => {});
}
const reportRoot = "/Volumes/T7/bigdata/eval-baselines/stage4";
await mkdir(reportRoot, { recursive: true });
const reportPath = join(reportRoot, `shutdown-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, reportPath })}\n`);
