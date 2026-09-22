import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "@aios/shared";
import { isLoopback, isLocalBrowserRequest } from "../auth.js";
import type { AppContext } from "../context.js";
import { registerAuthRoutes } from "../routes/auth.js";

/**
 * 무인증 모드의 두 안전장치를 고정한다.
 *  1) 루프백 판정이 소켓 주소만 본다 (헤더로 위조 불가)
 *  2) 프로덕션에서는 부팅이 거부된다
 * 이 둘 중 하나라도 깨지면 조직 데이터가 무인증으로 열린다.
 */

const sock = (remoteAddress?: string) =>
  ({ socket: { remoteAddress } }) as unknown as Parameters<typeof isLoopback>[0];

describe("isLoopback", () => {
  it("루프백 주소를 통과시킨다", () => {
    for (const a of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopback(sock(a)), a).toBe(true);
    }
  });

  it("그 외 주소는 거부한다", () => {
    for (const a of ["10.0.0.5", "192.168.1.7", "::ffff:10.0.0.5", "2001:db8::1", "", undefined]) {
      expect(isLoopback(sock(a)), String(a)).toBe(false);
    }
  });
});

const baseEnv = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("로컬 브라우저 경계", () => {
  const request = (headers: Record<string, string | undefined>) => ({ headers }) as Parameters<typeof isLocalBrowserRequest>[0];
  it("같은 오리진과 로컬 CLI를 허용한다", () => {
    expect(isLocalBrowserRequest(request({ host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" }))).toBe(true);
    expect(isLocalBrowserRequest(request({ host: "localhost:8791" }))).toBe(true);
  });
  it("외부 웹사이트, DNS rebinding, 다른 포트, opaque origin을 거부한다", () => {
    for (const headers of [
      { host: "127.0.0.1:8791", origin: "https://evil.example" },
      { host: "evil.example:8791", origin: "http://evil.example:8791" },
      { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8792" },
      { host: "127.0.0.1:8791", origin: "null" },
      { host: "127.0.0.1:8791", "sec-fetch-site": "cross-site" },
    ]) expect(isLocalBrowserRequest(request(headers))).toBe(false);
  });
});

describe("LOCAL_NO_AUTH 파싱", () => {
  it("기본값은 꺼짐", () => {
    expect(loadEnv({ ...baseEnv }).LOCAL_NO_AUTH).toBe(false);
  });

  it("'0' 과 'false' 는 꺼짐 — coerce.boolean 이었다면 둘 다 켜졌다", () => {
    expect(loadEnv({ ...baseEnv, LOCAL_NO_AUTH: "0" }).LOCAL_NO_AUTH).toBe(false);
    expect(loadEnv({ ...baseEnv, LOCAL_NO_AUTH: "false" }).LOCAL_NO_AUTH).toBe(false);
  });

  it("'1' 과 'true' 만 켜짐", () => {
    expect(loadEnv({ ...baseEnv, LOCAL_NO_AUTH: "1" }).LOCAL_NO_AUTH).toBe(true);
    expect(loadEnv({ ...baseEnv, LOCAL_NO_AUTH: "true" }).LOCAL_NO_AUTH).toBe(true);
  });

  it("프로덕션에서 켜면 부팅을 거부한다", () => {
    expect(() =>
      loadEnv({ ...baseEnv, LOCAL_NO_AUTH: "1", NODE_ENV: "production" }),
    ).toThrow(/LOCAL_NO_AUTH/);
  });

  it("프로덕션이어도 꺼져 있으면 통과한다", () => {
    expect(loadEnv({ ...baseEnv, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });
});

describe("공개 인증 capability", () => {
  it.each([
    { local: true, expected: "local-no-auth" },
    { local: false, expected: "credentials-required" },
  ])("LOCAL_NO_AUTH=$local을 DB 접근 없이 $expected로 공개한다", async ({ local, expected }) => {
    const query = vi.fn();
    const app = Fastify();
    registerAuthRoutes(app, {
      env: { LOCAL_NO_AUTH: local, AUTH_SESSION_TTL_DAYS: 30 },
      pool: { query },
    } as unknown as AppContext);
    try {
      const response = await app.inject("/v1/auth/providers");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ providers: [], sessionTtlDays: 30, authMode: expected });
      expect(query).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
