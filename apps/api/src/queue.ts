import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context.js";

/**
 * 큐 정의 — BullMQ.
 * 큐에 넣는 기준: "사용자 응답 경로에 있으면 안 되는 것" (인덱싱, 메모리 후처리).
 * removeOnComplete/Fail 상한: Redis를 잡 무덤으로 만들지 않는다.
 */

export interface IndexJobData {
  projectId: string;
  rootDir: string;
  orgId: string;
}

export interface MemoryJobData {
  sessionId: string;
  orgId: string;
  userId?: string;
  projectId?: string;
  extractFacts?: boolean;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export function createQueues(ctx: AppContext) {
  const connection = ctx.redis;
  return {
    index: new Queue<IndexJobData>("index", { connection, defaultJobOptions }),
    memory: new Queue<MemoryJobData>("memory", { connection, defaultJobOptions }),
  };
}

let queues: ReturnType<typeof createQueues> | null = null;

export async function enqueueIndexJob(ctx: AppContext, data: IndexJobData): Promise<string> {
  queues ??= createQueues(ctx);
  const job = await queues.index.add("index-project", data);
  return job.id!;
}

export async function enqueueMemoryJob(ctx: AppContext, data: MemoryJobData): Promise<void> {
  queues ??= createQueues(ctx);
  const jobId = `mem-${data.sessionId}`;
  const existing = await queues.memory.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      // 이전 버전의 완료 잡이 같은 ID를 영구 점유해 두 번째 턴부터 무시되는 문제를 복구한다.
      await existing.remove();
    } else if (state === "delayed" || state === "waiting") {
      // 빠른 응답 → 깊이 생각으로 바뀐 턴의 추출 요청을 중복 제거 과정에서 잃지 않는다.
      await existing.updateData({ ...data, extractFacts: existing.data.extractFacts !== false || data.extractFacts !== false });
      return;
    } else {
      // 이미 실행 중인 잡의 스냅샷은 바꿀 수 없으므로 후속 턴을 별도로 처리한다.
      await queues.memory.add("extract", data, { jobId: `${jobId}-${randomUUID()}`, delay: 30_000, removeOnComplete: true, removeOnFail: true });
      return;
    }
  }
  await queues.memory.add("extract", data, { jobId, delay: 30_000, removeOnComplete: true, removeOnFail: true });
}
