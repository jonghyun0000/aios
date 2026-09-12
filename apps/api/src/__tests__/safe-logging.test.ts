import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { safeErrorSummary, safeLoggerOptions } from "../safe-logging.js";

describe("자격증명을 저장하지 않는 요청·오류 로그", () => {
  it("API/worker 정형 오류 요약은 허용된 종류·코드·상태만 남긴다", () => {
    const marker = "SYNTHETIC_ONLY_WORKER_ERROR";
    const error = Object.assign(new Error(marker), { code: "ECONNREFUSED", status: 502, config: { authorization: marker }, cause: new Error(marker) });
    expect(safeErrorSummary(error)).toEqual({ type: "Error", code: "ECONNREFUSED", status: 502 });
    expect(JSON.stringify(safeErrorSummary(error))).not.toContain(marker);
    error.code = marker;
    expect(safeErrorSummary(error)).toEqual({ type: "Error", status: 502 });
    expect(safeErrorSummary({ name: marker, code: marker, message: marker, stack: marker, status: marker })).toEqual({ type: "Error" });
  });
  it("오류 객체의 비정상 getter나 원시값도 안전하게 요약한다", () => {
    expect(safeErrorSummary({ get code() { throw new Error("SYNTHETIC_ONLY_GETTER"); } })).toEqual({ type: "Error" });
    expect(safeErrorSummary("SYNTHETIC_ONLY_PRIMITIVE")).toEqual({ type: "Error" });
  });
  it("query 전체와 Authorization/Cookie/Set-Cookie를 출력하지 않는다", async () => {
    const lines: string[] = [];
    const marker = "SYNTHETIC_ONLY_LOG_FIXTURE";
    const app = Fastify({ logger: { ...safeLoggerOptions("info"), stream: { write: (line: string) => { lines.push(line); } } } });
    app.get("/fixture", async (req) => {
      req.log.info({ headers: { authorization: marker, cookie: marker, "set-cookie": marker, Authorization: marker, Cookie: marker, "Set-Cookie": marker } }, "fixture explicit headers");
      const err = Object.assign(new Error(marker), { config: { token: marker }, cause: new Error(marker), status: 502 });
      req.log.error({ err }, "fixture upstream failure");
      return { ok: true };
    });
    try {
      await app.inject({ url: `/fixture?token=${marker}&code=${marker}`, headers: { authorization: `Bearer ${marker}`, cookie: `session=${marker}` } });
      const log = lines.join("");
      expect(log).not.toContain(marker);
      expect(log).toContain('"url":"/fixture"');
      expect(log).toContain('"type":"Error"');
      expect(log).toContain('"status":502');
      expect(log).toContain("[redacted]");
      expect(log).toContain('"stack":"[redacted]"');
      expect(log).not.toContain('"config"');
    } finally { await app.close(); }
  });
  it("결함 주입: 기본 logger는 같은 합성 query와 Error 본문을 노출한다", async () => {
    const lines: string[] = [];
    const marker = "SYNTHETIC_ONLY_LOG_FAULT";
    const app = Fastify({ logger: { stream: { write: (line: string) => { lines.push(line); } } } });
    app.get("/fixture", async (req) => { req.log.error({ err: new Error(marker) }, "fixture failure"); return {}; });
    try {
      await app.inject(`/fixture?token=${marker}`);
      expect(lines.join("")).toContain(marker);
    } finally { await app.close(); }
  });
});
