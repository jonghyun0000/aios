import cors from "@fastify/cors";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CORS_OPTIONS } from "../cors-options.js";

/**
 * 프리플라이트는 브라우저만 보낸다. 그래서 라우트 단위 시험에서는 이 계약이 빠져도 아무도 모른다.
 * 여기서는 실제 @fastify/cors 플러그인에 우리 옵션을 물려 OPTIONS 를 직접 보낸다.
 */
async function preflight(method: string, origin = "http://localhost:5173") {
  const app = Fastify();
  await app.register(cors, CORS_OPTIONS);
  app.route({ method, url: "/v1/thing", handler: async () => ({ ok: true }) });
  const res = await app.inject({
    method: "OPTIONS",
    url: "/v1/thing",
    headers: { origin, "access-control-request-method": method },
  });
  await app.close();
  return res;
}

describe("CORS 프리플라이트 계약", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("%s 를 허용 메서드로 광고한다", async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers["access-control-allow-methods"]).split(/\s*,\s*/);
    expect(allowed).toContain(method);
  });

  it("요청 오리진을 그대로 돌려주고 자격증명을 허용한다(쿠키 세션이 다른 오리진에서 동작)", async () => {
    const res = await preflight("DELETE", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("허용 목록에 없는 메서드(TRACE/CONNECT)는 광고하지 않는다", async () => {
    const res = await preflight("PUT");
    const allowed = String(res.headers["access-control-allow-methods"]);
    expect(allowed).not.toMatch(/TRACE|CONNECT/);
  });
});
