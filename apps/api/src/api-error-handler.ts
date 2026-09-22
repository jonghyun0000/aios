import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AiosError } from "@aios/shared";

const CLIENT_DISCONNECT_CODES = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * 연결이 실제로 사라졌고 오류도 전송 중단 계열일 때만 정상적인 요청 수명 종료로 본다.
 * AbortError만 확인하면 서버 내부 타임아웃까지 숨기므로 소켓 상태를 반드시 함께 본다.
 */
export function isClientDisconnectError(err: unknown, req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.raw.aborted && !req.raw.destroyed && !reply.raw.destroyed) return false;
  if (!err || typeof err !== "object") return false;
  const record = err as { name?: unknown; code?: unknown };
  return record.name === "AbortError"
    || (typeof record.code === "string" && CLIENT_DISCONNECT_CODES.has(record.code));
}

/** API 전체가 같은 4xx/5xx 및 로깅 계약을 사용하게 하는 단일 오류 경계. */
export function installApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AiosError) {
      return reply.status(err.status).send(err.toJSON());
    }
    // zod 검증 실패는 클라이언트 잘못이지 서버 장애가 아니다.
    // 매핑하지 않으면 잘못된 UUID나 `?limit=99999`가 500으로 나간다.
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: "invalid request parameters",
          retryable: false,
          details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    }
    if (isClientDisconnectError(err, req, reply)) {
      // 이미 사라진 클라이언트에는 응답할 대상이 없다. debug 근거만 남겨 실제 장애의
      // error 경보와 분리하고, 파괴된 소켓에 500을 다시 쓰지 않는다.
      req.log.debug({ err }, "request stopped after client disconnect");
      return;
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "internal error", retryable: true } });
  });
}
