import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { QuotaExceededError } from "@aios/shared";
import type { Usage } from "@aios/shared";

/**
 * 사용량 계량기.
 *
 * 이중 기록 구조:
 *  - Postgres usage_events: 과금의 원장(append-only). 정확성이 우선, 지연 허용.
 *  - Redis 월 카운터: 쿼터 검사용. hot path에서 DB 집계 쿼리를 돌리지 않기 위한 캐시.
 * 쿼터 검사가 근사치여도 되는 이유: 한도 초과 수천 토큰의 원가는 무시 가능하고,
 * 정산은 어차피 원장 기준이다. hot path 지연이 훨씬 비싸다.
 */
export class UsageMeter {
  private queue: { orgId?: string; userId?: string; sessionId?: string; provider: string; model: string; usage: Usage }[] = [];
  private current: { orgId?: string; userId?: string; sessionId?: string } = {};

  constructor(
    private pool: Pool,
    private redis: Redis,
  ) {
    // 배치 플러시: 요청마다 insert 하지 않고 2초 주기로 모아 쓴다
    setInterval(() => void this.flush(), 2000).unref();
  }

  /** 요청 시작 시 현재 주체 설정 (라우터 onUsage 훅은 주체를 모르므로) */
  bind(subject: { orgId: string; userId?: string; sessionId?: string }): void {
    this.current = subject;
  }

  recordDeferred(e: { provider: string; model: string; usage: Usage }): void {
    this.queue.push({ ...this.current, ...e });
    const { orgId } = this.current;
    if (orgId) {
      const key = this.monthKey(orgId);
      const total = e.usage.inputTokens + e.usage.outputTokens;
      void this.redis
        .multi()
        .incrby(key, total)
        .expire(key, 40 * 24 * 3600)
        .exec()
        .catch(() => {});
    }
  }

  async checkQuota(orgId: string): Promise<void> {
    const [used, quota] = await Promise.all([
      this.redis.get(this.monthKey(orgId)).then((v) => Number(v ?? 0)),
      this.getQuota(orgId),
    ]);
    if (used >= quota) throw new QuotaExceededError();
  }

  private quotaCache = new Map<string, { value: number; at: number }>();

  private async getQuota(orgId: string): Promise<number> {
    const cached = this.quotaCache.get(orgId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const { rows } = await this.pool.query<{ included_tokens: string }>(
      `select p.included_tokens from subscriptions s join plans p on p.id = s.plan_id where s.org_id = $1`,
      [orgId],
    );
    const value = rows[0] ? Number(rows[0].included_tokens) : 2_000_000; // 미구독 = free
    this.quotaCache.set(orgId, { value, at: Date.now() });
    return value;
  }

  private monthKey(orgId: string): string {
    const d = new Date();
    return `usage:${orgId}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const values: unknown[] = [];
    const rows = batch
      .map((e, i) => {
        const o = i * 8;
        values.push(
          e.orgId ?? null, e.userId ?? null, e.sessionId ?? null, "chat",
          e.provider, e.model, e.usage.inputTokens, e.usage.outputTokens,
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
      })
      .join(",");
    await this.pool
      .query(
        `insert into usage_events (org_id, user_id, session_id, kind, provider, model, input_tokens, output_tokens) values ${rows}`,
        values,
      )
      .catch(() => {
        this.queue.unshift(...batch); // 실패 시 되돌려 다음 플러시에서 재시도 — 원장 유실 방지
      });
  }
}
