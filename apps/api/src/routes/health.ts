import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * 헬스 체크 3종. 쿠버네티스/로드밸런서가 서로 다른 질문을 하기 때문에 분리한다.
 *
 *  /healthz  (liveness)  — "프로세스가 살아 있는가?" 의존성을 확인하지 않는다.
 *      DB가 잠깐 죽었다고 파드를 재시작하면 장애가 증폭된다(재시작 폭풍).
 *  /readyz   (readiness) — "트래픽을 받을 준비가 됐는가?" DB/Redis 왕복을 확인한다.
 *      실패 시 파드는 살아 있되 LB에서 빠진다 — 이것이 올바른 반응이다.
 *  /metrics  (Prometheus) — 스크레이프용 텍스트 노출.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const startedAt = Date.now();

  app.get("/healthz", async () => ({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.GIT_SHA ?? "dev",
  }));

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};

    const probe = async (name: string, fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      try {
        await fn();
        checks[name] = { ok: true, latencyMs: Date.now() - t0 };
      } catch (err) {
        checks[name] = { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
      }
    };

    await Promise.all([
      probe("postgres", () => ctx.pool.query("select 1")),
      probe("redis", () => ctx.redis.ping()),
    ]);

    const ready = Object.values(checks).every((c) => c.ok);
    return reply.status(ready ? 200 : 503).send({ ready, checks });
  });

  /**
   * Prometheus 텍스트 포맷. prom-client를 쓰지 않는 이유: 노출 지표가 십수 개인 단계에서
   * 라이브러리의 레지스트리·라벨 추상화는 이득보다 결합을 만든다. 지표가 수십 개로 늘면 교체.
   */
  app.get("/metrics", async (_req, reply) => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const models = ctx.router.snapshot();

    const lines: string[] = [
      "# HELP aios_up 1 if the process is serving",
      "# TYPE aios_up gauge",
      "aios_up 1",
      "# HELP aios_uptime_seconds Process uptime",
      "# TYPE aios_uptime_seconds counter",
      `aios_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      "# HELP aios_heap_bytes Node heap in use",
      "# TYPE aios_heap_bytes gauge",
      `aios_heap_bytes ${mem.heapUsed}`,
      "# HELP aios_rss_bytes Resident set size",
      "# TYPE aios_rss_bytes gauge",
      `aios_rss_bytes ${mem.rss}`,
      "# HELP aios_cpu_seconds_total CPU time consumed",
      "# TYPE aios_cpu_seconds_total counter",
      `aios_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`,
      "# HELP aios_pg_pool_total Postgres pool connections",
      "# TYPE aios_pg_pool_total gauge",
      `aios_pg_pool_total ${ctx.pool.totalCount}`,
      `# HELP aios_pg_pool_idle Idle Postgres pool connections`,
      "# TYPE aios_pg_pool_idle gauge",
      `aios_pg_pool_idle ${ctx.pool.idleCount}`,
      "# HELP aios_pg_pool_waiting Requests waiting for a Postgres connection",
      "# TYPE aios_pg_pool_waiting gauge",
      `aios_pg_pool_waiting ${ctx.pool.waitingCount}`,
      "# HELP aios_model_circuit_open 1 when a model's circuit breaker is open",
      "# TYPE aios_model_circuit_open gauge",
      "# HELP aios_model_latency_ms EWMA latency per model",
      "# TYPE aios_model_latency_ms gauge",
      "# HELP aios_model_success_rate Rolling success rate per model",
      "# TYPE aios_model_success_rate gauge",
    ];
    for (const m of models) {
      const labels = `{provider="${m.provider}",model="${m.model}"}`;
      lines.push(`aios_model_circuit_open${labels} ${m.open ? 1 : 0}`);
      lines.push(`aios_model_latency_ms${labels} ${Math.round(m.ewmaLatencyMs)}`);
      lines.push(`aios_model_success_rate${labels} ${m.successRate.toFixed(4)}`);
    }

    return reply.header("content-type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });
}
