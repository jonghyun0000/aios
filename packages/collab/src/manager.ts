/**
 * RoomManager — docId → Room 라이프사이클.
 *
 * 왜 별도 클래스인가: Room 생성은 DB 로드를 동반하는 비동기 작업이다.
 * 같은 문서에 두 피어가 동시에 접속하면 Room이 두 개 만들어질 수 있고(레이스),
 * 그러면 두 사람은 서로 다른 문서를 편집하게 된다. 그래서 생성 중인 Promise를
 * 캐시해 한 번만 만들어지게 한다.
 */
import type { Redis } from "ioredis";
import { Room, type Peer, type RoomBroadcaster } from "./room.js";
import type { DocPersistence } from "./persistence.js";

const CHANNEL_PREFIX = "collab:doc:";

export interface RoomManagerOptions {
  persistence: DocPersistence;
  /** 인스턴스 간 전파용. 없으면 단일 프로세스 모드 */
  pub?: Redis;
  sub?: Redis;
  /** 마지막 피어 이탈 후 룸을 메모리에 유지할 시간(ms). 재접속이 잦으므로 즉시 버리지 않는다. */
  idleTtlMs?: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private pending = new Map<string, Promise<Room>>();
  private reapTimers = new Map<string, NodeJS.Timeout>();
  private reaping = new Map<string, Promise<void>>();
  private subscribed = new Set<string>();
  private broadcaster?: RoomBroadcaster;
  private idleTtlMs: number;
  private closed = false;

  constructor(private opts: RoomManagerOptions) {
    this.idleTtlMs = opts.idleTtlMs ?? 30_000;

    if (opts.pub) {
      const pub = opts.pub;
      this.broadcaster = {
        // publish에 Buffer를 넘긴다 — base64로 감싸면 33% 대역폭을 낭비한다.
        // 수신은 messageBuffer 이벤트로 받아야 바이너리가 문자열로 깨지지 않는다.
        publish: (docId, payload) => {
          void pub.publish(CHANNEL_PREFIX + docId, Buffer.from(payload));
        },
      };
    }
    if (opts.sub) {
      opts.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
        const docId = channel.toString("utf8").slice(CHANNEL_PREFIX.length);
        const room = this.rooms.get(docId);
        // 룸이 없다 = 이 인스턴스에 해당 문서 피어가 없다 → 버려도 안전하다.
        // 나중에 피어가 붙으면 DB 스냅샷 + 다른 인스턴스의 sync로 따라잡는다.
        if (room) room.applyRemote(new Uint8Array(message));
      });
    }
  }

  async join(docId: string, peer: Peer): Promise<Room> {
    if (this.closed) throw new Error("협업 서버가 종료 중입니다.");
    const room = await this.acquire(docId);
    if (this.closed) throw new Error("협업 서버가 종료 중입니다.");
    const timer = this.reapTimers.get(docId);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(docId);
    }
    await room.addPeer(peer);
    return room;
  }

  async leave(docId: string, peer: Peer): Promise<void> {
    const room = this.rooms.get(docId);
    if (!room) return;
    const empty = await room.removePeer(peer);
    if (empty) this.scheduleReap(docId, room);
  }

  get(docId: string): Room | undefined {
    return this.rooms.get(docId);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  private async acquire(docId: string): Promise<Room> {
    // 저장 후 파기 중인 룸에는 새 편집자를 넣지 않는다. 완료 후 DB에서 다시 읽는다.
    if (this.reaping.has(docId)) await this.reaping.get(docId);
    const existing = this.rooms.get(docId);
    if (existing) return existing;
    const inflight = this.pending.get(docId);
    if (inflight) return inflight;

    const promise = (async () => {
      const room = new Room(docId, this.opts.persistence, this.broadcaster);
      await room.load();
      if (this.opts.sub && !this.subscribed.has(docId)) {
        await this.opts.sub.subscribe(CHANNEL_PREFIX + docId);
        this.subscribed.add(docId);
      }
      this.rooms.set(docId, room);
      return room;
    })();

    this.pending.set(docId, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(docId);
    }
  }

  private scheduleReap(docId: string, room: Room): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.reapTimers.delete(docId);
      // TTL 동안 누군가 다시 들어왔을 수 있다 — 반드시 재확인한다.
      if (room.peerCount > 0) return;
      // 저장 실패 시 룸을 유지해야 종료 단계에서 다시 flush할 수 있다.
      const reaping = room.dispose().then(() => {
        if (this.rooms.get(docId) === room) this.rooms.delete(docId);
        if (this.opts.sub && this.subscribed.delete(docId)) {
          void this.opts.sub.unsubscribe(CHANNEL_PREFIX + docId).catch(() => undefined);
        }
      }).finally(() => { this.reaping.delete(docId); });
      this.reaping.set(docId, reaping);
      void reaping.catch(() => { this.scheduleReap(docId, room); });
    }, this.idleTtlMs);
    timer.unref?.();
    this.reapTimers.set(docId, timer);
  }

  /** 모든 저장을 시도하되 하나라도 실패하면 정상 종료라고 알리지 않는다. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
    // 로드 중이던 룸도 종료 스냅샷에서 빠지지 않아야 한다.
    const loading = await Promise.allSettled([...this.pending.values()]);
    const rooms = [...this.rooms.entries()];
    const saved = await Promise.allSettled(rooms.map(async ([id, room]) => {
      await room.dispose();
      if (this.rooms.get(id) === room) this.rooms.delete(id);
    }));
    const errors = [...loading, ...saved].flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, "협업 문서 저장에 실패했습니다. 정상 종료 또는 안전한 백업으로 처리할 수 없습니다.");
  }
}
