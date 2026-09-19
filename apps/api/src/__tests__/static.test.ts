import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWebUi } from "../static.js";

/**
 * 웹 UI 서빙 계약. @fastify/static 을 올릴 때 setHeaders 의 인자가 raw 응답에서 FastifyReply 로
 * 바뀌었다 — 타입 검사는 잡았지만, 잡히지 않았다면 모든 정적 파일 요청이 런타임에 실패했을 변경이다.
 */
describe("웹 UI 정적 서빙", () => {
  let dir: string;
  let prevDist: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aios-static-test-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>AIOS-INDEX</title>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('bundle')");
    writeFileSync(join(dir, "favicon.txt"), "plain");
    prevDist = process.env.AIOS_WEB_DIST;
    process.env.AIOS_WEB_DIST = dir;
  });
  afterAll(() => {
    if (prevDist === undefined) delete process.env.AIOS_WEB_DIST; else process.env.AIOS_WEB_DIST = prevDist;
    rmSync(dir, { recursive: true, force: true });
  });

  async function build() {
    const app = Fastify();
    app.get("/v1/ping", async () => ({ pong: true }));
    expect(await registerWebUi(app)).toBe(true);
    return app;
  }

  it("index.html 은 캐시하지 않는다(새 배포가 사용자에게 도달해야 한다)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/index.html" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain("AIOS-INDEX");
    await app.close();
  });

  it("해시가 붙은 assets 는 영구 캐시한다", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    await app.close();
  });

  it("그 외 파일에는 우리가 캐시 정책을 덮어쓰지 않는다", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/favicon.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).not.toMatch(/immutable|no-cache/);
    await app.close();
  });

  it("SPA 폴백: 모르는 화면 경로는 index.html 을 돌려준다", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/billing" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("AIOS-INDEX");
    await app.close();
  });

  it("API 경로의 404 는 HTML 이 아니라 JSON 404 다", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });

  it("등록된 API 라우트를 정적 서빙이 가리지 않는다", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/v1/ping" });
    expect(res.json()).toEqual({ pong: true });
    await app.close();
  });

  it("경로 탈출(../)로 루트 밖 파일을 읽을 수 없다", async () => {
    const app = await build();
    for (const url of ["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2f..%2fetc%2fpasswd"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toMatch(/root:.*:0:0/);
    }
    await app.close();
  });
});
