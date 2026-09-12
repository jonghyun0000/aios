import type { FastifyServerOptions } from "fastify";

const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "AiosError", "AuthError", "ForbiddenError", "NotFoundError", "ValidationError", "ProviderError", "QuotaExceededError", "ToolExecutionError", "ToolDeniedError"]);
const ERROR_CODES = new Set(["EACCES", "EPERM", "ENOENT", "EIO", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EADDRINUSE", "ERR_INVALID_URL", "28P01", "28000", "3D000", "42P01", "23505", "53300", "57P01", "08006", "validation_error", "unauthorized", "forbidden", "not_found", "provider_error", "workspace_required", "workspace_forbidden", "file_conflict"]);

/** HTTP logger뿐 아니라 API/worker의 초기화 실패와 작업 실패에도 동일한 비밀 없는 요약을 쓴다. */
export function safeErrorSummary(error: unknown): { type: string; code?: string; status?: number } {
  const summary: { type: string; code?: string; status?: number } = { type: "Error" };
  try {
    if (error instanceof Error && ERROR_TYPES.has(error.constructor.name)) summary.type = error.constructor.name;
    if (error && typeof error === "object") {
      if ("code" in error && typeof error.code === "string" && ERROR_CODES.has(error.code)) summary.code = error.code;
      if ("status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) summary.status = error.status;
    }
  } catch { /* 오류 객체의 getter/알 수 없는 형태도 진단을 실패시키거나 원문을 노출하지 않는다. */ }
  return summary;
}

/** 요청 본문·헤더·쿼리와 Error의 message/stack/config/cause는 자격증명을 담을 수 있다. */
export function safeLoggerOptions(level: "info" | "debug"): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']",
        "headers.authorization", "headers.cookie", "headers['set-cookie']",
        "headers.Authorization", "headers.Cookie", "headers['Set-Cookie']",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(request: { method?: string; url?: string; hostname?: string; ip?: string }) {
        return { method: request.method, url: request.url?.split(/[?#]/, 1)[0], hostname: request.hostname, remoteAddress: request.ip };
      },
      err(error: unknown) {
        // 외부 오류의 message/stack/config를 그대로 직렬화하지 않는다.
        // reqId + 경로 + 오류 종류/상태로 상관관계를 찾고, 비밀 없는 상세 원인은 별도로 계측한다.
        return { ...safeErrorSummary(error), message: "[redacted]", stack: "[redacted]" };
      },
    },
  };
}
