import { createContext } from "./context.js";
import { buildServer } from "./server.js";
import { safeErrorSummary } from "./safe-logging.js";
import { loadEnv } from "@aios/shared";
import { acquireLocalApiOwnership, LocalApiOwnershipError } from "./execution/ownership.js";

/**
 * API 서버 엔트리포인트.
 * graceful shutdown: SIGTERM 수신 → 신규 연결 거부 → 진행 중 스트림 완료 대기 → 자원 정리.
 * 롤링 배포에서 진행 중인 SSE 스트림을 자르지 않기 위한 최소 조건.
 */
async function main() {
  // DB를 달리 설정하거나 다른 포트로 띄워도 같은 호스트 폴더에 쓰는 API는 하나뿐이어야 한다.
  const workspace = loadEnv().LOCAL_WORKSPACE_ROOT;
  const ownership = workspace ? await acquireLocalApiOwnership(workspace) : undefined;
  const ctx = await createContext();
  const app = await buildServer(ctx);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // 중복 시그널 무시: 배포 중 SIGTERM이 두 번 오면 close()가 겹쳐 예외가 난다
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    // 시그널 핸들러는 동기 함수여야 한다. async 함수를 그대로 넘기면 reject가 유실되어
    // 프로세스가 좀비로 남고 실패 원인도 로그에 남지 않는다.
    void (async () => {
      try {
        await app.close(); // fastify가 in-flight 요청 완료를 기다린다
        await ctx.close();
        await ownership?.release();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, "graceful shutdown failed; exiting anyway");
        process.exit(1);
      }
    })();

    // 종료가 걸려도 영원히 매달리지 않는다 — 오케스트레이터의 SIGKILL을 기다리는 것보다
    // 우리가 예측 가능한 시점에 죽는 편이 배포를 덜 아프게 한다.
    setTimeout(() => {
      app.log.error("shutdown timed out after 25s; forcing exit");
      process.exit(1);
    }, 25_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: ctx.env.PORT, host: ctx.env.LOCAL_NO_AUTH ? "127.0.0.1" : ctx.env.HOST });
}

main().catch((err) => {
  // 이 클래스의 안내는 고정 문구뿐이다. 외부 오류 원문이나 설정값을 다시 노출하지 않는다.
  console.error(JSON.stringify({ event: "api.start_failed", error: err instanceof LocalApiOwnershipError ? { code: err.code, message: err.message } : safeErrorSummary(err) }));
  process.exit(1);
});
