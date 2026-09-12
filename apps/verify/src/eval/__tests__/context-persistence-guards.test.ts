import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { localPersistenceEndpoints } from "../context-persistence-guards.js";

const valid = { AIOS_CONTEXT_PERSISTENCE_TEST: "1", DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture", REDIS_URL: "redis://127.0.0.1:6379" };
describe("영속 맥락 실사용 시험 진입 경계", () => {
  it("명시적 opt-in과 로컬 DB/Redis가 모두 있어야 한다", () => {
    expect(localPersistenceEndpoints(valid).base).toBe("http://127.0.0.1:8791");
    for (const field of ["AIOS_CONTEXT_PERSISTENCE_TEST", "DATABASE_URL", "REDIS_URL"]) expect(() => localPersistenceEndpoints({ ...valid, [field]: undefined })).toThrow();
  });
  it("외부 서비스·잘못된 프로토콜·API 자격증명·숨은 경로를 거부한다", () => {
    for (const [field, value] of [
      ["AIOS_BASE_URL", "https://example.com"], ["DATABASE_URL", "postgresql://example.com/fixture"], ["REDIS_URL", "redis://example.com"],
      ["AIOS_BASE_URL", "http://fixture:fixture@localhost:8791"], ["AIOS_BASE_URL", "http://localhost:8791/api"],
      ["AIOS_BASE_URL", "http://localhost:8791/?token=fixture"], ["AIOS_BASE_URL", "http://localhost:8791/#private"],
      ["DATABASE_URL", "http://localhost/fixture"], ["REDIS_URL", "http://localhost"], ["DATABASE_URL", "not-a-url"],
    ]) expect(() => localPersistenceEndpoints({ ...valid, [field!]: value })).toThrow();
  });
  it("URL hostname과 다른 실제 pg 호스트를 만드는 query 우회를 연결 전에 거부한다", () => {
    const override = "postgresql://fixture:fixture@127.0.0.1/fixture?host=remote.example.invalid";
    const client = new Client({ connectionString: override }); // 생성만 한다. connect()는 호출하지 않는다.
    expect(client.host).toBe("remote.example.invalid");
    expect(() => localPersistenceEndpoints({ ...valid, DATABASE_URL: override })).toThrow(/쿼리/);
    for (const option of ["?sslcert=%2Fprivate%2Ffixture.pem", "?sslkey=%2Fprivate%2Ffixture.pem", "#fixture"]) {
      expect(() => localPersistenceEndpoints({ ...valid, DATABASE_URL: valid.DATABASE_URL + option })).toThrow();
      expect(() => localPersistenceEndpoints({ ...valid, REDIS_URL: valid.REDIS_URL + option })).toThrow();
    }
  });
});
