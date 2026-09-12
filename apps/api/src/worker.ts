import { Worker } from "bullmq";
import { createContext } from "./context.js";
import { enqueueMemoryJob, type IndexJobData, type MemoryJobData } from "./queue.js";
import { closeWorkersThenContext } from "./shutdown.js";

/**
 * 백그라운드 워커 프로세스 — api와 같은 코드베이스, 다른 엔트리포인트.
 * 처리 잡: 코드베이스 인덱싱 / STM 압축 + LTM 사실 추출 / (EventBus 구독).
 */
async function main() {
  const ctx = await createContext();
  const log = (msg: string, extra?: unknown) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg, extra }));

  // --- 인덱싱 워커 (동시성 2: 임베딩 rate limit과 메모리 사용량의 균형) ---
  const indexWorker = new Worker<IndexJobData>(
    "index",
    async (job) => {
      const { projectId, rootDir, orgId } = job.data;
      const result = await ctx.indexer.indexProject(projectId, rootDir, (p) => {
        void job.updateProgress(Math.round((p.done / Math.max(p.total, 1)) * 100));
        void ctx.bus.publish({ type: "index.progress", orgId, payload: { projectId, ...p } });
      });
      await ctx.bus.publish({ type: "index.completed", orgId, payload: { projectId, ...result } });
      return result;
    },
    { connection: ctx.redis, concurrency: 2 },
  );

  // --- 메모리 워커: STM 압축(선제) + LTM 사실 추출 ---
  const memoryWorker = new Worker<MemoryJobData>(
    "memory",
    async (job) => {
      const { sessionId, orgId, userId, projectId } = job.data;
      await ctx.memory.maybeCompact(sessionId);
      const window = await ctx.memory.stm.getWindow(sessionId);
      if (job.data.extractFacts !== false && window.messages.length >= 4) {
        const stored = await ctx.memory.extractAndStore({ orgId, userId, projectId }, sessionId, window.messages);
        log("memory.extracted", { sessionId, stored });
      }
    },
    { connection: ctx.redis, concurrency: 4 },
  );

  // --- EventBus 구독: 턴 종료 → 메모리 잡 enqueue ---
  void ctx.bus.subscribe("memory-pipeline", `worker-${process.pid}`, async (e) => {
    if (e.type === "session.turn_completed") {
      await enqueueMemoryJob(ctx, {
        sessionId: e.payload.sessionId as string,
        orgId: e.orgId!,
        userId: e.payload.userId as string | undefined,
        projectId: e.payload.projectId as string | undefined,
        extractFacts: e.payload.extractFacts !== false,
      });
    }
  });

  for (const w of [indexWorker, memoryWorker]) {
    w.on("failed", (job, err) => log("job.failed", { queue: w.name, id: job?.id, err: err.message }));
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("worker.shutdown", { signal });
    ctx.bus.stop();
    // 시그널 핸들러는 동기여야 한다(async를 그대로 넘기면 reject가 유실된다).
    // BullMQ의 close()는 진행 중인 잡이 끝날 때까지 기다린다 — 인덱싱 잡을 중간에 버리지 않는다.
    void (async () => {
      try {
        await closeWorkersThenContext([indexWorker, memoryWorker], () => ctx.close());
        process.exit(0);
      } catch {
        log("worker.shutdown_failed");
        process.exit(1);
      }
    })();
    setTimeout(() => {
      log("worker.shutdown_timeout");
      process.exit(1);
    }, 30_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log("worker.started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
