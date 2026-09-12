/**
 * Yjs 문서 영속화.
 *
 * 왜 필요한가: 서버가 재시작되면 메모리의 Y.Doc이 사라진다. 모든 피어가 끊긴 상태에서
 * 재시작되면 문서 내용이 통째로 증발한다 — 협업 도구에서 이건 데이터 손실이다.
 *
 * 저장 형식은 Yjs의 상태 스냅샷(바이너리)이다. 텍스트로 풀어 저장하지 않는 이유:
 * CRDT의 병합 이력(누가 언제 무엇을)을 잃으면 재접속 시 충돌 해결이 불가능해진다.
 *
 * 저장 시점 설계:
 *  - 매 업데이트마다 저장하면 타이핑 1회당 DB 쓰기가 발생한다(과도).
 *  - 마지막 피어가 나갈 때만 저장하면 서버가 죽을 때 유실된다.
 *  → 디바운스(기본 2초) + 마지막 피어 이탈 시 즉시 저장, 둘 다 한다.
 */
import type { Pool } from "pg";
import * as Y from "yjs";

export interface DocPersistence {
  load(docId: string): Promise<Uint8Array | null>;
  save(docId: string, state: Uint8Array): Promise<void>;
}

export class PostgresDocPersistence implements DocPersistence {
  constructor(
    private pool: Pool,
    private orgId: string,
  ) {}

  async load(docId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query<{ state: Buffer }>(
      `select state from collab_docs where org_id = $1 and doc_id = $2`,
      [this.orgId, docId],
    );
    return rows[0] ? new Uint8Array(rows[0].state) : null;
  }

  async save(docId: string, state: Uint8Array): Promise<void> {
    await this.pool.query(
      `insert into collab_docs (org_id, doc_id, state, updated_at)
       values ($1, $2, $3, now())
       on conflict (org_id, doc_id)
       do update set state = excluded.state, updated_at = now()`,
      [this.orgId, docId, Buffer.from(state)],
    );
  }
}

/** 테스트·단일 프로세스용 인메모리 구현 */
export class MemoryDocPersistence implements DocPersistence {
  private store = new Map<string, Uint8Array>();
  load(docId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.store.get(docId) ?? null);
  }
  save(docId: string, state: Uint8Array): Promise<void> {
    this.store.set(docId, state);
    return Promise.resolve();
  }
}

/**
 * 디바운스 저장기.
 * flush()는 즉시 저장한다 — 마지막 피어 이탈이나 셧다운 시 호출한다.
 */
export class DebouncedSaver {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private saving: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private persistence: DocPersistence,
    private docId: string,
    private doc: Y.Doc,
    private delayMs = 2000,
  ) {}

  schedule(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // 일시적인 DB 장애는 다음 저장 기회를 남긴다. 마지막 flush의 실패는 호출자에게
      // 전파하므로 정상 종료/백업으로 오판하지 않으며 타이머 reject도 유실하지 않는다.
      void this.flush().catch(() => { this.schedule(); });
    }, this.delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.saving) {
      await this.saving;
      return this.flush();
    }
    if (!this.pending) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const state = Y.encodeStateAsUpdate(this.doc);
    this.pending = false;
    // 저장을 직렬화하지 않으면 늦게 끝난 이전 스냅샷이 최신 편집을 덮어쓸 수 있다.
    this.saving = Promise.resolve().then(() => this.persistence.save(this.docId, state))
      .catch((err: unknown) => { this.pending = true; throw err; })
      .finally(() => { this.saving = null; });
    await this.saving;
    if (this.pending) await this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
