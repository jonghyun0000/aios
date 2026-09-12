import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.js";
import { isExpectedMissingSession } from "../lib/settings-session.js";

describe("설정 세션 상태 구분", () => {
  it("로컬/API 키의 세션 없음만 정상으로 본다", () => {
    for (const via of ["local", "api_key", "jwt"] as const) {
      for (const status of [401, 404]) expect(isExpectedMissingSession(new ApiError(status, "missing", "세션 없음"), via)).toBe(true);
    }
  });
  it("결함 주입: 같은 인증 방식이어도 500/503/통신 오류를 숨기지 않는다", () => {
    for (const error of [new ApiError(500, "db_error", "DB 실패"), new ApiError(503, "unavailable", "연결 실패"), new TypeError("Failed to fetch")]) {
      expect(isExpectedMissingSession(error, "local")).toBe(false);
    }
  });
  it("OAuth 세션 만료와 알 수 없는 인증 상태는 정상으로 오인하지 않는다", () => {
    expect(isExpectedMissingSession(new ApiError(401, "expired", "세션 만료"), "session")).toBe(false);
    expect(isExpectedMissingSession(new ApiError(401, "missing", "세션 없음"), undefined)).toBe(false);
  });
});
