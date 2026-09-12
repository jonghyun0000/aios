/**
 * Sprint #3 — 실시간 협업 실제 검증.
 *
 * 유닛 테스트(packages/collab)는 Peer 인터페이스에 직접 붙어 WS 계층을 건너뛴다.
 * 여기서는 진짜 HTTP 서버를 띄우고, 진짜 WebSocket 두 개를 연결해
 * 브라우저가 겪는 것과 동일한 경로(핸드셰이크 → 인증 → 바이너리 프레임 → Postgres 영속화)를
 * 통과시킨다. "두 클라이언트로 테스트된 적이 없다"는 것이 이 기능의 원래 결함이었으므로
 * 이 검증이 없으면 고쳤다고 말할 수 없다.
 */
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import pg from "pg";
import { Report } from "./report.js";

const BASE = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = process.env.AIOS_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** 실제 WebSocket 위에서 도는 Yjs 클라이언트 (y-websocket 최소 구현) */
class WsClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws!: WebSocket;
  synced = false;

  constructor(private url: string) {}

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

    this.awareness.on("update", ({ added, updated, removed }: {added:number[];updated:number[];removed:number[]}, origin: unknown) => {
      if (origin === "remote") return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.send(encoding.toUint8Array(enc));
    });

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
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      this.ws.on("open", () => { clearTimeout(timer); resolve(); });
      this.ws.on("error", (err) => { clearTimeout(timer); reject(err); });
      this.ws.on("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`closed before open: ${code} ${reason.toString()}`));
      });
    });
  }

  private send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  text(): string { return this.doc.getText("body").toJSON(); }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

/** 조건이 참이 될 때까지 폴링. 고정 sleep은 느리거나 불안정하다. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const report = new Report("Sprint#3 Phase A — 실시간 협업 (실서버 + 실 WebSocket)");

if (!TOKEN) {
  report.check("AIOS_API_KEY 환경변수", false, "API 키 없이는 WS 인증을 통과할 수 없다");
  report.finish();
}

const docName = `verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const url = (doc: string) => `${WS_BASE}/v1/collab?doc=${encodeURIComponent(doc)}&token=${TOKEN}`;

report.section("A.1 연결 및 인증");

await report.guard("인증 없는 연결은 4401로 거부된다", async () => {
  const ws = new WebSocket(`${WS_BASE}/v1/collab?doc=${docName}`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no close within 8s")), 8000);
    ws.on("close", (c) => { clearTimeout(timer); resolve(c); });
    ws.on("error", () => { /* close가 뒤따른다 */ });
  });
  // 4401을 요구한다. 1006(HTTP 401로 업그레이드 자체가 거부)도 '막긴 했다'지만
  // 클라이언트가 이유를 구분할 수 없어 재인증 UX가 불가능하므로 PASS로 치지 않는다.
  report.check("무인증 거부 (4401)", code === 4401, `close code = ${code}`);
});

await report.guard("doc 파라미터 없으면 4400", async () => {
  const ws = new WebSocket(`${WS_BASE}/v1/collab?token=${TOKEN}`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no close within 8s")), 8000);
    ws.on("close", (c) => { clearTimeout(timer); resolve(c); });
    ws.on("error", () => {});
  });
  report.check("doc 누락 거부 (4400)", code === 4400, `close code = ${code}`);
});

let a: WsClient | null = null;
let b: WsClient | null = null;

report.section("A.2 두 클라이언트 동기화");

await report.guard("A→B 전파", async () => {
  a = new WsClient(url(docName));
  b = new WsClient(url(docName));
  await a.connect();
  await b.connect();
  await waitFor(() => a!.synced && b!.synced, 5000, "initial sync");

  a.doc.getText("body").insert(0, "hello ");
  await waitFor(() => b!.text() === "hello ", 5000, "B가 A의 편집을 수신");
  report.check("A의 편집이 B에 도달", b.text() === "hello ", `B="${b.text()}"`);
});

await report.guard("B→A 전파 (양방향)", async () => {
  b!.doc.getText("body").insert(b!.text().length, "world");
  await waitFor(() => a!.text() === "hello world", 5000, "A가 B의 편집을 수신");
  report.check("양방향 동기화", a!.text() === "hello world", `A="${a!.text()}"`);
});

await report.guard("동시 편집 수렴 (CRDT)", async () => {
  a!.doc.getText("body").insert(0, "[A]");
  b!.doc.getText("body").insert(0, "[B]");
  await waitFor(() => a!.text() === b!.text(), 5000, "수렴");
  report.check("양쪽 문서가 동일", a!.text() === b!.text(), `"${a!.text()}"`);
  report.check("양쪽 편집이 모두 보존", a!.text().includes("[A]") && a!.text().includes("[B]"), a!.text());
});

report.section("A.3 늦게 접속한 클라이언트");

await report.guard("late joiner가 기존 문서를 받는다", async () => {
  const late = new WsClient(url(docName));
  await late.connect();
  await waitFor(() => late.text() === a!.text() && late.text().length > 0, 5000, "late sync");
  report.check("기존 내용 수신", late.text() === a!.text(), `late="${late.text()}"`);
  await late.close();
});

report.section("A.4 awareness (커서 공유)");

await report.guard("커서 상태 전파", async () => {
  a!.awareness.setLocalState({ user: { name: "Alice", color: "#f00" }, cursor: { index: 3 } });
  await waitFor(
    () => [...b!.awareness.getStates().values()].some((s) => (s as {user?:{name?:string}})?.user?.name === "Alice"),
    5000, "B가 Alice 커서를 인지",
  );
  report.check("원격 커서 인지", true, `states=${b!.awareness.getStates().size}`);
});

await report.guard("이탈 시 유령 커서 제거", async () => {
  const aClientId = a!.doc.clientID;
  await a!.close();
  await waitFor(() => !b!.awareness.getStates().has(aClientId), 5000, "커서 정리");
  report.check("유령 커서 없음", !b!.awareness.getStates().has(aClientId), `remaining=${b!.awareness.getStates().size}`);
});

report.section("A.5 Postgres 영속화");

let savedText = "";
await report.guard("마지막 피어 이탈 시 DB 저장", async () => {
  savedText = b!.text();
  await b!.close();
  if (!DATABASE_URL) throw new Error("DATABASE_URL 필요");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 저장은 마지막 피어 이탈 시 즉시 수행되지만 소켓 close 이벤트가 비동기라 잠깐 기다린다
    let row: { state: Buffer } | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ state: Buffer }>(
        "select state from collab_docs where doc_id like $1", [`%${docName}`],
      );
      if (rows[0]) { row = rows[0]; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    report.check("collab_docs 행 존재", !!row, row ? `${row.state.length} bytes` : "행 없음");
    if (row) {
      const restored = new Y.Doc();
      Y.applyUpdate(restored, new Uint8Array(row.state));
      const text = restored.getText("body").toJSON();
      report.check("스냅샷이 실제 내용을 담고 있다", text === savedText, `db="${text}" expected="${savedText}"`);
    }
  } finally {
    await client.end();
  }
});

await report.guard("재접속 시 서버가 문서를 복원한다", async () => {
  const c = new WsClient(url(docName));
  await c.connect();
  await waitFor(() => c.text() === savedText, 8000, "복원");
  report.check("복원된 문서 일치", c.text() === savedText, `restored="${c.text()}"`);
  await c.close();
});

report.section("A.6 부하 — 10 클라이언트 동시 편집");

await report.guard("10 클라이언트가 모두 같은 결과로 수렴", async () => {
  const doc = `${docName}-load`;
  const clients = Array.from({ length: 10 }, () => new WsClient(url(doc)));
  await Promise.all(clients.map((c) => c.connect()));
  await waitFor(() => clients.every((c) => c.synced), 10_000, "전원 sync");

  const started = Date.now();
  clients.forEach((c, i) => c.doc.getText("body").insert(0, `<${i}>`));

  await waitFor(
    () => {
      const first = clients[0]!.text();
      return first.length === 30 && clients.every((c) => c.text() === first);
    },
    15_000,
    "10자 편집 전원 수렴",
  );
  const elapsed = Date.now() - started;
  const final = clients[0]!.text();
  report.check("전원 동일 문서", clients.every((c) => c.text() === final), `len=${final.length}`);
  report.check("모든 편집 보존", Array.from({ length: 10 }, (_, i) => final.includes(`<${i}>`)).every(Boolean), final);
  report.check("수렴 지연 < 2000ms", elapsed < 2000, `${elapsed}ms`);
  await Promise.all(clients.map((c) => c.close()));
});

report.finish();
