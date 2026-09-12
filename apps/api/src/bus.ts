import type { Redis } from "ioredis";

/**
 * Event Bus — Redis Streams 기반.
 *
 * PubSub이 아닌 Streams를 쓰는 이유: PubSub은 구독자가 없거나 죽어 있으면 이벤트가 증발한다.
 * 과금·메모리 추출처럼 유실되면 안 되는 이벤트에는 at-least-once가 필요하다.
 * consumer group + XAUTOCLAIM으로 죽은 컨슈머의 pending 메시지를 회수한다.
 * (실시간 협업 릴레이는 반대로 유실 허용·저지연이 우선이라 PubSub을 쓴다 — ws.ts)
 */

export interface BusEvent {
  type: string;
  orgId?: string;
  payload: Record<string, unknown>;
}

const STREAM = "aios:events";
const MAXLEN = 100_000; // 무한 성장 방지 — 소비 완료분은 어차피 DB에 반영됨

export class EventBus {
  private running = false;

  constructor(private redis: Redis) {}

  async publish(event: BusEvent): Promise<void> {
    await this.redis.xadd(STREAM, "MAXLEN", "~", String(MAXLEN), "*", "event", JSON.stringify(event));
  }

  /**
   * 컨슈머 루프. group당 한 번만 처리(작업 분배), 다른 group은 같은 이벤트를 독립 소비.
   * handler가 throw하면 ack하지 않는다 → pending으로 남아 재처리된다.
   */
  async subscribe(group: string, consumer: string, handler: (e: BusEvent) => Promise<void>): Promise<void> {
    await this.redis.xgroup("CREATE", STREAM, group, "0", "MKSTREAM").catch((err: Error) => {
      if (!err.message.includes("BUSYGROUP")) throw err;
    });
    this.running = true;

    // 별도 커넥션: XREADGROUP BLOCK은 커넥션을 점유한다
    const sub = this.redis.duplicate();
    while (this.running) {
      try {
        // 1) 죽은 컨슈머의 5분 초과 pending 회수
        const claimed = (await sub.xautoclaim(STREAM, group, consumer, 300_000, "0", "COUNT", 10)) as [
          string,
          [string, string[]][],
        ];
        for (const [id, fields] of claimed[1] ?? []) {
          await this.dispatch(sub, group, id, fields, handler);
        }
        // 2) 신규 메시지
        const res = (await sub.xreadgroup(
          "GROUP", group, consumer, "COUNT", "10", "BLOCK", "5000", "STREAMS", STREAM, ">",
        )) as [string, [string, string[]][]][] | null;
        for (const [, entries] of res ?? []) {
          for (const [id, fields] of entries) {
            await this.dispatch(sub, group, id, fields, handler);
          }
        }
      } catch (err) {
        if (!this.running) break;
        // 버스 루프는 절대 죽지 않는다 — 백오프 후 재시도
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await sub.quit();
  }

  private async dispatch(
    conn: Redis,
    group: string,
    id: string,
    fields: string[],
    handler: (e: BusEvent) => Promise<void>,
  ): Promise<void> {
    const idx = fields.indexOf("event");
    if (idx === -1 || fields[idx + 1] === undefined) {
      await conn.xack(STREAM, group, id); // 형식 불량은 재처리해도 소용없다 — poison 제거
      return;
    }
    try {
      await handler(JSON.parse(fields[idx + 1]!) as BusEvent);
      await conn.xack(STREAM, group, id);
    } catch {
      // no ack → pending으로 남아 XAUTOCLAIM 재처리 대상
    }
  }

  stop(): void {
    this.running = false;
  }
}
