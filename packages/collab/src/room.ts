/**
 * 협업 룸(문서 하나) 관리.
 *
 * 한 문서 = 한 Room. Room은 Y.Doc + Awareness + 연결된 피어 집합을 소유한다.
 *
 * 멀티 인스턴스 대응(핵심 설계 결정):
 *   API 서버를 2대 이상 띄우면 같은 문서의 피어가 서로 다른 인스턴스에 붙을 수 있다.
 *   그러면 인스턴스 A의 편집이 인스턴스 B의 피어에게 도달하지 않는다.
 *   → Redis Pub/Sub으로 update를 인스턴스 간에 전파한다.
 *   자기 자신이 발행한 메시지를 다시 적용하지 않도록 originId(인스턴스 UUID)를 붙인다.
 *   CRDT라 중복 적용해도 결과는 같지만, 무한 에코를 막아 대역폭을 아낀다.
 */
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import {
  encodeAwareness,
  encodeSyncStep1,
  encodeUpdate,
  handleMessage,
  type DocSession,
} from "./protocol.js";
import { DebouncedSaver, type DocPersistence } from "./persistence.js";

export interface Peer {
  id: string;
  userId: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Redis 전파용 훅. 단일 프로세스면 주입하지 않아도 동작한다. */
export interface RoomBroadcaster {
  publish(docId: string, payload: Uint8Array): Promise<void> | void;
}

const REMOTE_ORIGIN = Symbol("aios.collab.remote");
const LOCAL_ORIGIN = Symbol("aios.collab.local");

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  private peers = new Map<string, Peer>();
  /** awareness clientId → peer.id. 피어 이탈 시 해당 커서만 지우려고 가지고 있는다. */
  private clientOwners = new Map<number, string>();
  private saver: DebouncedSaver;
  private loaded = false;
  private disposed = false;
  private disposing: Promise<void> | null = null;

  constructor(
    readonly docId: string,
    private persistence: DocPersistence,
    private broadcaster?: RoomBroadcaster,
  ) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // 서버 자신은 awareness 상태를 갖지 않는다. 커서를 가진 사람이 아니므로.
    this.awareness.setLocalState(null);
    this.saver = new DebouncedSaver(persistence, docId, this.doc);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // 로컬 피어에게 전파
      const msg = encodeUpdate(update);
      for (const [pid, peer] of this.peers) {
        if (origin === peer) continue; // 보낸 사람에게 되돌리지 않는다
        this.safeSend(pid, peer, msg);
      }
      // 원격에서 온 업데이트를 다시 원격으로 보내면 에코 루프가 된다
      if (origin !== REMOTE_ORIGIN && this.broadcaster) {
        void this.broadcaster.publish(this.docId, encodeUpdate(update));
      }
      this.saver.schedule();
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        // origin이 Peer면 그 피어가 소유한 clientId다. 이탈 시 이 커서만 지운다.
        if (origin && typeof origin === "object" && "id" in (origin as Peer)) {
          const ownerId = (origin as Peer).id;
          for (const clientId of [...added, ...updated]) this.clientOwners.set(clientId, ownerId);
          for (const clientId of removed) this.clientOwners.delete(clientId);
        }
        const msg = encodeAwareness(this.awareness, changed);
        for (const [pid, peer] of this.peers) {
          if (origin === peer) continue;
          this.safeSend(pid, peer, msg);
        }
        if (origin !== REMOTE_ORIGIN && this.broadcaster) {
          void this.broadcaster.publish(this.docId, msg);
        }
      },
    );
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** DB에 저장된 스냅샷을 한 번만 적용. 피어가 붙기 전에 호출해야 한다. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const state = await this.persistence.load(this.docId);
    if (state && state.byteLength > 0) {
      Y.applyUpdate(this.doc, state, LOCAL_ORIGIN);
    }
  }

  async addPeer(peer: Peer): Promise<void> {
    await this.load();
    this.peers.set(peer.id, peer);

    // 1) 내 상태 벡터를 보내 diff를 요청 — 피어가 가진 로컬 변경을 받아온다
    peer.send(encodeSyncStep1(this.doc));
    // 2) 현재 문서 전체를 즉시 보낸다 — 늦게 온 피어도 바로 내용을 본다.
    //    (단순 릴레이 구현에서 빠져 있던 바로 그 부분)
    peer.send(encodeUpdate(Y.encodeStateAsUpdate(this.doc)));
    // 3) 기존 참여자들의 커서 상태
    const states = this.awareness.getStates();
    if (states.size > 0) {
      peer.send(encodeAwareness(this.awareness, [...states.keys()]));
    }
  }

  handle(peer: Peer, message: Uint8Array): void {
    const session: DocSession = { doc: this.doc, awareness: this.awareness };
    const { reply, broadcast } = handleMessage(session, message, peer);
    if (reply) peer.send(reply);
    if (broadcast) {
      for (const [pid, other] of this.peers) {
        if (other === peer) continue;
        this.safeSend(pid, other, broadcast);
      }
      if (this.broadcaster) void this.broadcaster.publish(this.docId, broadcast);
    }
  }

  /** 다른 인스턴스에서 Redis로 넘어온 메시지 */
  applyRemote(message: Uint8Array): void {
    const session: DocSession = { doc: this.doc, awareness: this.awareness };
    const { broadcast } = handleMessage(session, message, REMOTE_ORIGIN);
    if (broadcast) {
      for (const [pid, peer] of this.peers) this.safeSend(pid, peer, broadcast);
    }
  }

  async removePeer(peer: Peer): Promise<boolean> {
    this.peers.delete(peer.id);
    // 나간 사람의 커서를 정리하지 않으면 유령 커서가 남는다.
    // 어느 clientId가 이 피어의 것인지는 awareness 메시지를 받을 때 기록해 둔다.
    const owned: number[] = [];
    for (const [clientId, ownerId] of this.clientOwners) {
      if (ownerId === peer.id) owned.push(clientId);
    }
    for (const clientId of owned) this.clientOwners.delete(clientId);
    if (owned.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, owned, peer);
    }
    if (this.peers.size === 0) {
      // 마지막 피어 이탈 → 즉시 저장. 디바운스만 믿으면 프로세스 종료 시 유실된다.
      await this.saver.flush();
      return true; // 룸을 회수해도 좋다
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposing) return this.disposing;
    this.disposing = (async () => {
      // 실패한 문서를 먼저 파기하면 재시도할 최신 상태까지 잃는다.
      await this.saver.flush();
      this.saver.dispose();
      this.awareness.destroy();
      this.doc.destroy();
      this.disposed = true;
    })().finally(() => { this.disposing = null; });
    return this.disposing;
  }

  /**
   * 한 피어의 소켓이 죽어도 다른 피어의 전파가 멈추면 안 된다.
   * send가 던지면 그 피어만 격리한다.
   */
  private safeSend(pid: string, peer: Peer, data: Uint8Array): void {
    try {
      peer.send(data);
    } catch {
      this.peers.delete(pid);
      try {
        peer.close(1011, "send failed");
      } catch {
        /* 이미 닫힌 소켓 */
      }
    }
  }
}
