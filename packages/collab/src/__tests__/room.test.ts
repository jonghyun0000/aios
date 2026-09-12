import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { MemoryDocPersistence } from "../persistence.js";
import { RoomManager } from "../manager.js";
import type { Peer } from "../room.js";
import { encodeAwareness, handleMessage, MESSAGE_SYNC, MESSAGE_AWARENESS } from "../protocol.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

/**
 * 인프로세스 Yjs 클라이언트.
 * 실제 y-websocket 클라이언트가 하는 일(step1 응답, update 전송)을 그대로 수행한다.
 * WS 프레이밍은 테스트 대상이 아니므로 Peer.send를 직접 이어 붙인다.
 */
class TestClient implements Peer {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly inbox: Uint8Array[] = [];
  private outbound: ((data: Uint8Array) => void) | null = null;
  closed = false;

  constructor(readonly id: string, readonly userId = "u-" + id) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return; // 서버에서 받은 건 되돌리지 않는다
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.outbound?.(encoding.toUint8Array(enc));
    });
    this.awareness.on("update", ({ added, updated, removed }: any, origin: unknown) => {
      if (origin === "remote") return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      this.outbound?.(encodeAwareness(this.awareness, changed));
    });
  }

  connect(toServer: (data: Uint8Array) => void): void {
    this.outbound = toServer;
  }

  /** 서버 → 클라이언트 */
  send(data: Uint8Array): void {
    if (this.closed) throw new Error("socket closed");
    this.inbox.push(data);
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MESSAGE_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
      if (encoding.length(enc) > 1) this.outbound?.(encoding.toUint8Array(enc));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), "remote");
    }
  }

  close(): void {
    this.closed = true;
  }

  text(): string {
    return this.doc.getText("body").toJSON();
  }
}

async function connect(manager: RoomManager, docId: string, client: TestClient) {
  const room = await manager.join(docId, client);
  client.connect((data) => room.handle(client, data));
  return room;
}

describe("Room — 두 클라이언트 수렴", () => {
  it("A의 편집이 B에게 전파된다", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    const b = new TestClient("b");
    await connect(manager, "doc1", a);
    await connect(manager, "doc1", b);

    a.doc.getText("body").insert(0, "hello ");
    expect(b.text()).toBe("hello ");

    b.doc.getText("body").insert(6, "world");
    expect(a.text()).toBe("hello world");
    await manager.close();
  });

  it("동시 편집이 양쪽에서 같은 결과로 수렴한다 (CRDT)", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    const b = new TestClient("b");
    await connect(manager, "doc2", a);
    await connect(manager, "doc2", b);

    a.doc.getText("body").insert(0, "AAA");
    b.doc.getText("body").insert(0, "BBB");

    expect(a.text()).toBe(b.text());
    expect(a.text().length).toBe(6);
    await manager.close();
  });

  it("늦게 접속한 클라이언트가 기존 문서 내용을 받는다", async () => {
    // 단순 릴레이 구현에서 실패하던 바로 그 케이스.
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    await connect(manager, "doc3", a);
    a.doc.getText("body").insert(0, "already here");

    const late = new TestClient("late");
    await connect(manager, "doc3", late);
    expect(late.text()).toBe("already here");
    await manager.close();
  });

  it("한 피어의 소켓이 죽어도 나머지 전파가 계속된다", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    const dead = new TestClient("dead");
    const c = new TestClient("c");
    await connect(manager, "doc4", a);
    await connect(manager, "doc4", dead);
    await connect(manager, "doc4", c);

    dead.close(); // send가 이제 throw한다

    a.doc.getText("body").insert(0, "still works");
    expect(c.text()).toBe("still works");
    await manager.close();
  });
});

describe("Room — 영속화", () => {
  it("마지막 피어가 나가면 저장되고, 새 룸이 복원한다", async () => {
    const persistence = new MemoryDocPersistence();
    const m1 = new RoomManager({ persistence });
    const a = new TestClient("a");
    await connect(m1, "doc5", a);
    a.doc.getText("body").insert(0, "persist me");
    await m1.leave("doc5", a);

    // 서버 재시작 시뮬레이션 — 완전히 새로운 매니저
    const m2 = new RoomManager({ persistence });
    const b = new TestClient("b");
    await connect(m2, "doc5", b);
    expect(b.text()).toBe("persist me");
    await m1.close();
    await m2.close();
  });

  it("close()가 모든 열린 문서를 저장한다", async () => {
    const persistence = new MemoryDocPersistence();
    const m1 = new RoomManager({ persistence });
    const a = new TestClient("a");
    await connect(m1, "doc6", a);
    a.doc.getText("body").insert(0, "graceful shutdown");
    await m1.close(); // 피어가 붙어 있는 채로 셧다운

    const m2 = new RoomManager({ persistence });
    const b = new TestClient("b");
    await connect(m2, "doc6", b);
    expect(b.text()).toBe("graceful shutdown");
    await m2.close();
  });
});

describe("Room — awareness (커서)", () => {
  it("커서 상태가 다른 피어에게 전파된다", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    const b = new TestClient("b");
    await connect(manager, "doc7", a);
    await connect(manager, "doc7", b);

    a.awareness.setLocalState({ user: { name: "Alice" }, cursor: { index: 3 } });

    const seen = [...b.awareness.getStates().values()];
    expect(seen.some((s: any) => s?.user?.name === "Alice")).toBe(true);
    await manager.close();
  });

  it("피어가 나가면 유령 커서가 제거된다", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const a = new TestClient("a");
    const b = new TestClient("b");
    await connect(manager, "doc8", a);
    await connect(manager, "doc8", b);

    a.awareness.setLocalState({ user: { name: "Alice" } });
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(true);

    await manager.leave("doc8", a);
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false);
    await manager.close();
  });
});

describe("Room — 견고성", () => {
  it("같은 문서 동시 접속에도 룸이 하나만 생성된다", async () => {
    const manager = new RoomManager({ persistence: new MemoryDocPersistence() });
    const clients = Array.from({ length: 8 }, (_, i) => new TestClient(`c${i}`));
    const rooms = await Promise.all(clients.map((c) => manager.join("race", c)));
    expect(new Set(rooms).size).toBe(1);
    expect(manager.roomCount).toBe(1);
    expect(rooms[0]!.peerCount).toBe(8);
    await manager.close();
  });

  it("알 수 없는 메시지 타입은 무시된다 (서버가 죽지 않는다)", () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 99);
    encoding.writeVarUint8Array(enc, new Uint8Array([1, 2, 3]));
    const res = handleMessage({ doc, awareness }, encoding.toUint8Array(enc), "x");
    expect(res.reply).toBeNull();
    expect(res.broadcast).toBeNull();
  });
});
