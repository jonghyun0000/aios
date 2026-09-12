import { ApiError, type Me } from "./api.js";

/** OAuth가 아닌 인증에는 브라우저 세션이 없어도 정상이다. 장애/만료는 별개다. */
export function isExpectedMissingSession(error: unknown, via: Me["via"] | undefined): boolean {
  return via !== "session" && via !== undefined && error instanceof ApiError && (error.status === 401 || error.status === 404);
}
