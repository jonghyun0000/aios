import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Agent, fetch as undiciFetch } from "undici";
import { LocalAdapter } from "../providers/local.js";

/**
 * 헤더 타임아웃 회귀 테스트.
 *
 * 실제로 겪은 장애: 로컬 서버가 요청을 큐에 두고 기다리게 하는 동안 응답 헤더를 보내지
 * 않는데, Node 내장 fetch 의 헤더 타임아웃 300초를 넘기면 `UND_ERR_HEADERS_TIMEOUT` 으로
 * 죽는다. 서버도 요청도 멀쩡한데 "줄을 섰다"는 이유로 실패한다.
 *
 * 300초를 기다릴 수 없으므로 같은 메커니즘을 작은 규모로 시험한다 —
 * 헤더를 일부러 늦게 보내는 서버를 세우고, 타임아웃이 걸린 경우와 끈 경우를 비교한다.
 */

/*
 * undici 의 헤더 타임아웃은 공용 타이머로 검사해 해상도가 거칠다(수백 ms 단위).
 * 400ms 지연 / 100ms 타임아웃으로는 발동하지 않아 시험이 성립하지 않았다.
 * 실제로 발동하는 크기로 벌린다.
 */
const HEADER_DELAY_MS = 3_000;
const IMPATIENT_TIMEOUT_MS = 500;

/** 헤더를 HEADER_DELAY_MS 만큼 늦게 보내는 서버. 로컬 추론 서버의 큐 대기를 흉내낸다. */
function slowHeaderServer(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0, 1] }] }));
      }, HEADER_DELAY_MS);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const servers: (() => Promise<void>)[] = [];
afterAll(async () => { for (const c of servers) await c(); });

describe("로컬 어댑터 헤더 타임아웃", () => {
  it("헤더 타임아웃이 짧으면 정상 요청도 죽는다 — 이것이 우리가 겪은 장애다", async () => {
    const s = await slowHeaderServer();
    servers.push(s.close);
    const impatient = new Agent({ headersTimeout: IMPATIENT_TIMEOUT_MS });
    await expect(
      undiciFetch(`${s.url}/embeddings`, { method: "POST", dispatcher: impatient, body: "{}" }),
    ).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
  });

  it("LocalAdapter 는 헤더가 늦어도 기다린다", async () => {
    const s = await slowHeaderServer();
    servers.push(s.close);
    // 위 시험이 죽는 지연을 그대로 주고도 성공해야 한다.
    const a = new LocalAdapter(s.url, "bge-m3");
    await expect(a.embed(["느린 서버"])).resolves.toEqual([[0, 1]]);
  });

  it("서버가 없으면 빨리 실패한다 — 무제한 대기가 아니다", async () => {
    // 타임아웃을 껐다고 해서 '응답 없는 주소'에 영원히 매달리면 안 된다.
    // connectTimeout 이 그 경우를 잡는다.
    const a = new LocalAdapter("http://127.0.0.1:1/v1", "bge-m3");
    const t0 = Date.now();
    await expect(a.embed(["연결 불가"])).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(11_000);
  });
});
