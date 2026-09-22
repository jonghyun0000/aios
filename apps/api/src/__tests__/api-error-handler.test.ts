import { request } from "node:http";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { installApiErrorHandler } from "../api-error-handler.js";
import { registerBigDataRoutes } from "../routes/bigdata.js";
import { safeLoggerOptions } from "../safe-logging.js";

function parsedLogs(lines: string[]): Array<{ level?: number; msg?: string }> {
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as { level?: number; msg?: string }]; }
    catch { return []; }
  });
}

describe("API 오류 경계", () => {
  it("실제 TCP 클라이언트 종료로 중단된 bigdata 요청은 error 로그를 만들지 않는다", async () => {
    const lines: string[] = [];
    let startQuery!: () => void;
    const queryStarted = new Promise<void>((resolve) => { startQuery = resolve; });
    let observeHandler!: () => void;
    const handlerObserved = new Promise<void>((resolve) => { observeHandler = resolve; });
    const app = Fastify({
      logger: {
        ...safeLoggerOptions("debug"),
        stream: {
          write(line: string) {
            lines.push(line);
            if (line.includes("request stopped after client disconnect") || line.includes("unhandled error")) observeHandler();
          },
        },
      },
    });
    const query = vi.fn(async (_sql: string, signal: AbortSignal) => {
      startQuery();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
        }, { once: true });
      });
    });
    installApiErrorHandler(app);
    registerBigDataRoutes(app, { bigdata: { timeoutMs: 10_000, query } } as unknown as AppContext);

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const client = request(`${address}/v1/bigdata/categories`);
      client.on("error", () => {});
      client.end();
      await queryStarted;
      client.destroy();
      await handlerObserved;

      const logs = parsedLogs(lines);
      expect(logs.filter(({ level }) => (level ?? 0) >= 50)).toHaveLength(0);
      expect(logs.some(({ msg }) => msg === "request stopped after client disconnect")).toBe(true);
      expect(query).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    { path: "/abort", error: new DOMException("synthetic live request abort", "AbortError") },
    { path: "/ordinary", error: new Error("synthetic ordinary failure") },
  ])("연결이 살아 있는 $path 오류는 500과 error 로그를 유지한다", async ({ path, error }) => {
    const lines: string[] = [];
    const app = Fastify({ logger: { ...safeLoggerOptions("debug"), stream: { write: (line: string) => { lines.push(line); } } } });
    installApiErrorHandler(app);
    app.get(path, async () => { throw error; });
    try {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "internal" } });
      expect(parsedLogs(lines).filter(({ level }) => (level ?? 0) >= 50)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
