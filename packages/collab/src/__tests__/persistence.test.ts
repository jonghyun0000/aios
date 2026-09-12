import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DebouncedSaver, MemoryDocPersistence, type DocPersistence } from "../persistence.js";
import { RoomManager } from "../manager.js";
import type { Peer } from "../room.js";

const peer = (id: string): Peer => ({ id, userId: id, send() {}, close() {} });
function text(state: Uint8Array | null): string {
  const doc = new Y.Doc();
  try { if (state) Y.applyUpdate(doc, state); return doc.getText("body").toJSON(); }
  finally { doc.destroy(); }
}

afterEach(() => { vi.useRealTimers(); });

describe("협업 저장 장애 주입", () => {
  it("저장 실패를 전파하고 같은 내용으로 재시도할 수 있다", async () => {
    const store = new MemoryDocPersistence();
    let fail = true;
    const persistence: DocPersistence = {
      load: (id) => store.load(id),
      save: async (id, state) => { if (fail) throw new Error("injected disk failure"); await store.save(id, state); },
    };
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "저장되어야 하는 편집");
    const saver = new DebouncedSaver(persistence, "retry", doc);
    saver.schedule();
    await expect(saver.flush()).rejects.toThrow("injected disk failure");
    expect(await store.load("retry")).toBeNull();
    fail = false;
    await saver.flush();
    expect(text(await store.load("retry"))).toBe("저장되어야 하는 편집");
    saver.dispose(); doc.destroy();
  });

  it("저장 중 새 편집과 동시 flush가 들어와도 최신 스냅샷이 마지막이다", async () => {
    const store = new MemoryDocPersistence();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshots: string[] = [];
    const persistence: DocPersistence = {
      load: (id) => store.load(id),
      save: async (id, state) => {
        snapshots.push(text(state));
        if (snapshots.length === 1) await gate;
        await store.save(id, state);
      },
    };
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "첫 편집");
    const saver = new DebouncedSaver(persistence, "ordered", doc);
    saver.schedule();
    const first = saver.flush();
    await Promise.resolve();
    doc.getText("body").insert(4, " + 다음 편집");
    saver.schedule();
    const second = saver.flush();
    await Promise.resolve();
    expect(snapshots).toEqual(["첫 편집"]);
    release();
    await Promise.all([first, second]);
    expect(snapshots).toEqual(["첫 편집", "첫 편집 + 다음 편집"]);
    expect(text(await store.load("ordered"))).toBe("첫 편집 + 다음 편집");
    saver.dispose(); doc.destroy();
  });

  it("디바운스 DB 장애는 미처리 reject 대신 저장 재시도를 남긴다", async () => {
    vi.useFakeTimers();
    const store = new MemoryDocPersistence();
    let calls = 0;
    const persistence: DocPersistence = {
      load: (id) => store.load(id),
      save: async (id, state) => { if (++calls === 1) throw new Error("injected transient DB failure"); await store.save(id, state); },
    };
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "자동 재시도");
    const saver = new DebouncedSaver(persistence, "timer", doc, 20);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toBe(1);
    expect(await store.load("timer")).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toBe(2);
    expect(text(await store.load("timer"))).toBe("자동 재시도");
    saver.dispose(); doc.destroy();
  });

  it("한 문서 저장 실패도 종료 실패이며 정상 문서는 저장하고 실패 문서는 재시도한다", async () => {
    const store = new MemoryDocPersistence();
    let fail = true;
    const manager = new RoomManager({ persistence: {
      load: (id) => store.load(id),
      save: async (id, state) => { if (id === "broken" && fail) throw new Error("injected flush failure"); await store.save(id, state); },
    } });
    const good = await manager.join("good", peer("g"));
    const broken = await manager.join("broken", peer("b"));
    good.doc.getText("body").insert(0, "정상 문서");
    broken.doc.getText("body").insert(0, "실패 문서도 보존");
    await expect(manager.close()).rejects.toThrow("협업 문서 저장에 실패");
    expect(text(await store.load("good"))).toBe("정상 문서");
    expect(await store.load("broken")).toBeNull();
    expect(manager.roomCount).toBe(1);
    await expect(manager.join("new", peer("n"))).rejects.toThrow("종료 중");
    fail = false;
    await manager.close();
    expect(text(await store.load("broken"))).toBe("실패 문서도 보존");
    expect(manager.roomCount).toBe(0);
  });

  it("종료 도중 로드되는 문서를 놓치지 않고 신규 피어는 거부한다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new MemoryDocPersistence();
    const original = new Y.Doc();
    original.getText("body").insert(0, "로딩 중 문서");
    await store.save("loading", Y.encodeStateAsUpdate(original)); original.destroy();
    const manager = new RoomManager({ persistence: {
      load: async (id) => { await gate; return store.load(id); },
      save: (id, state) => store.save(id, state),
    } });
    const joining = manager.join("loading", peer("late"));
    const rejected = expect(joining).rejects.toThrow("종료 중");
    const closing = manager.close();
    release();
    await rejected; await closing;
    expect(manager.roomCount).toBe(0);
    expect(text(await store.load("loading"))).toBe("로딩 중 문서");
  });
});
