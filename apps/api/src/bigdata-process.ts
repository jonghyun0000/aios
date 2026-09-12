import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { AiosError } from "@aios/shared";
import type { BigDataReader } from "@aios/tools";

interface Pending {
  resolve: (rows: unknown[]) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** SIGBUS는 try/catch나 Worker Thread로 격리할 수 없어 OS 프로세스 경계를 사용한다. */
export class BigDataProcess implements BigDataReader {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor(
    private dbPath: string,
    readonly timeoutMs = 30_000,
    private limits: { memory?: string; threads?: number } = {},
    private workerUrl = new URL("./bigdata-worker.js", import.meta.url),
  ) {}

  private start(): ChildProcess {
    if (this.closed) throw new Error("통계 엔진이 종료되었습니다.");
    if (this.child) return this.child;
    const worker = existsSync(this.workerUrl) ? this.workerUrl : new URL("./bigdata-worker.ts", import.meta.url);
    const child = fork(worker, [], {
      // BigInt 관측치가 JSON 직렬화 중 손실되지 않도록 Node의 구조화 직렬화를 쓴다.
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, AIOS_BIGDATA_CHILD: JSON.stringify({ dbPath: this.dbPath, timeoutMs: this.timeoutMs, limits: this.limits }) },
    });
    this.child = child;
    child.on("message", (message: { id: number; rows?: unknown[]; error?: string }) => {
      if (this.child !== child) return;
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      task.cleanup();
      if (message.error) task.reject(new AiosError("bigdata_query_failed", message.error, { status: 400 }));
      else task.resolve(message.rows ?? []);
    });
    child.on("error", () => this.fail(child));
    child.on("exit", () => this.fail(child));
    return child;
  }

  private fail(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    for (const task of this.pending.values()) {
      task.cleanup();
      task.reject(new AiosError("bigdata_unavailable", "통계 엔진이 중단되었습니다. 다시 조회하면 자동으로 복구됩니다.", { status: 503, retryable: true }));
    }
    this.pending.clear();
  }

  query<T = Record<string, unknown>>(sql: string, signal: AbortSignal): Promise<T[]> {
    signal.throwIfAborted();
    if (this.pending.size >= 32) return Promise.reject(new AiosError("bigdata_busy", "통계 조회가 많습니다. 잠시 후 다시 시도하세요.", { status: 503, retryable: true }));
    const child = this.start();
    const id = ++this.sequence;
    return new Promise<T[]>((resolve, reject) => {
      const onAbort = () => {
        const task = this.pending.get(id);
        if (!task) return;
        this.pending.delete(id);
        task.cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error("통계 조회를 취소했습니다."));
        if (child.connected) child.send({ cancel: id }, () => {});
      };
      // 네이티브 interrupt조차 응답하지 않는 경우 프로세스를 종료해 웹 서버를 보호한다.
      const timer = setTimeout(() => { child.kill("SIGKILL"); this.fail(child); }, this.timeoutMs + 5_000);
      this.pending.set(id, {
        resolve: (rows) => resolve(rows as T[]), reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      child.send({ id, sql }, (err) => { if (err) this.fail(child); });
    });
  }

  close(): void {
    this.closed = true;
    if (this.child) {
      const child = this.child;
      child.kill("SIGTERM");
      this.fail(child);
    }
  }
}
