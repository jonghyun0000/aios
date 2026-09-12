/**
 * Sprint #6 — 협업 멀티 인스턴스 검증.
 *
 * 왜 필요한가: 배포 문서에 "Redis Pub/Sub이 인스턴스 간 update를 전파하므로
 * sticky session은 **필요 없다**"고 적어 두었다. 그런데 그 경로는 단일 프로세스에서만
 * 검증됐다. 이 주장이 틀리면 수평 확장하는 순간 **다른 파드에 붙은 사용자끼리
 * 편집이 보이지 않는다** — 그것도 에러 없이 조용히.
 *
 * s3-collab 과 다른 점: 저기는 한 서버에 두 클라이언트를 붙인다.
 * 여기는 **서로 다른 서버**에 붙여 Redis를 실제로 통과시킨다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Report } from "./report.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const KEY = process.env.AIOS_API_KEY;
const PORT_A = 8793;
const PORT_B = 8794;

const r = new Report("Sprint#6 — 협업 멀티 인스턴스 (Redis 전파)");

if (!KEY) {
  r.check("AIOS_API_KEY 환경변수", false, "API 키 없이는 WS 인증을 통과할 수 없다");
  r.finish();
}

/** 실제 WebSocket 위에서 도는 Yjs 클라이언트 (s3-collab 과 동일 구현) */
class Client {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws!: WebSocket;
  synced = false;

  constructor(readonly label: string, private url: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === "remote") return;
        const ids = [...added, ...updated, ...removed];
        if (ids.length === 0) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
        this.send(encoding.toUint8Array(enc));
      },
    );

    this.ws.on("message", (raw: ArrayBuffer | Buffer) => {
      const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MESSAGE_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
        if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
        this.synced = true;
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), "remote");
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: ws open timeout`)), 15_000);
      this.ws.on("open", () => { clearTimeout(timer); resolve(); });
      this.ws.on("error", (err) => { clearTimeout(timer); reject(err); });
      this.ws.on("close", (code, reason) =>
        { clearTimeout(timer); reject(new Error(`${this.label}: closed ${code} ${reason.toString()}`)); });
    });
  }

  private send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  text(): string { return this.doc.getText("body").toJSON(); }
  peers(): number { return this.awareness.getStates().size; }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** 두 번째 API 인스턴스를 띄운다. 같은 Postgres·Redis를 공유해야 의미가 있다. */
function startInstance(port: number): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../../api", import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealthy(port: number, child: ChildProcess): Promise<void> {
  const logs: string[] = [];
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`instance ${port} did not start:\n${logs.join("").slice(-1500)}`);
}

const children: ChildProcess[] = [];
const doc = `multi-${Date.now()}`;
const url = (port: number, d: string) =>
  `ws://127.0.0.1:${port}/v1/collab?doc=${encodeURIComponent(d)}&token=${KEY!}`;

try {
  r.section("A. 두 인스턴스 기동");

  await r.guard("인스턴스 A·B가 같은 Redis·Postgres로 뜬다", async () => {
    for (const port of [PORT_A, PORT_B]) {
      const child = startInstance(port);
      children.push(child);
      await waitHealthy(port, child);
    }
    r.check("A 기동", true, `:${PORT_A}`);
    r.check("B 기동", true, `:${PORT_B}`);
  });

  let a: Client | null = null;
  let b: Client | null = null;

  r.section("B. 인스턴스 간 편집 전파");

  await r.guard("A의 편집이 B에 도달한다", async () => {
    a = new Client("A", url(PORT_A, doc));
    b = new Client("B", url(PORT_B, doc));
    await a.connect();
    await b.connect();
    await waitFor(() => a!.synced && b!.synced, 10_000, "초기 sync");

    a.doc.getText("body").insert(0, "A가 씁니다. ");
    // 이 대기가 실패하면 Redis 전파가 동작하지 않는다는 뜻이고,
    // 배포 문서의 "sticky session 불필요"가 거짓이 된다.
    await waitFor(() => b!.text().includes("A가 씁니다"), 10_000, "B가 A의 편집 수신");
    r.check("A → B 전파", b.text().includes("A가 씁니다"), `B="${b.text()}"`);
  });

  await r.guard("B의 편집이 A에 도달한다 (양방향)", async () => {
    b!.doc.getText("body").insert(b!.text().length, "B도 씁니다.");
    await waitFor(() => a!.text().includes("B도 씁니다"), 10_000, "A가 B의 편집 수신");
    r.check("B → A 전파", a!.text().includes("B도 씁니다"), `A="${a!.text()}"`);
  });

  await r.guard("동시 편집이 양쪽에서 같은 결과로 수렴한다", async () => {
    a!.doc.getText("body").insert(0, "[A]");
    b!.doc.getText("body").insert(0, "[B]");
    await waitFor(() => a!.text() === b!.text(), 10_000, "수렴");
    r.check("두 인스턴스 문서 동일", a!.text() === b!.text(), `"${a!.text()}"`);
    r.check("양쪽 편집 모두 보존", a!.text().includes("[A]") && a!.text().includes("[B]"), a!.text());
  });

  r.section("C. 프레즌스(awareness) 전파");

  await r.guard("커서 상태가 인스턴스를 건너 전달된다", async () => {
    a!.awareness.setLocalState({ user: { name: "Alice", color: "#f00" } });
    await waitFor(
      () => [...b!.awareness.getStates().values()]
        .some((s) => (s as { user?: { name?: string } })?.user?.name === "Alice"),
      10_000,
      "B가 Alice 커서를 인지",
    );
    r.check("A의 커서를 B가 본다", true, `B awareness=${b!.peers()}`);
  });

  r.section("D. 늦게 접속한 다른 인스턴스");

  await r.guard("C가 인스턴스 A에 붙어 기존 문서를 받는다", async () => {
    const c = new Client("C", url(PORT_A, doc));
    await c.connect();
    await waitFor(() => c.text() === a!.text() && c.text().length > 0, 10_000, "late sync");
    r.check("기존 내용 수신", c.text() === a!.text(), `C="${c.text()}"`);
    await c.close();
  });

  r.section("E. 문서 격리");

  await r.guard("다른 문서로는 전파되지 않는다", async () => {
    // 채널이 문서별로 분리돼 있지 않으면 무관한 문서끼리 내용이 섞인다.
    const other = new Client("other", url(PORT_B, `${doc}-other`));
    await other.connect();
    await waitFor(() => other.synced, 10_000, "other sync");
    a!.doc.getText("body").insert(0, "격리확인 ");
    // 잠시 기다려도 넘어오지 않아야 한다
    await new Promise((res) => setTimeout(res, 1500));
    r.check("다른 문서는 비어 있다", !other.text().includes("격리확인"), `other="${other.text()}"`);
    await other.close();
  });

  await a!.close();
  await b!.close();
} finally {
  for (const child of children) child.kill("SIGTERM");
}

r.finish();
