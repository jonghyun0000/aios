import { describe, it, expect } from "vitest";
import { BigDataProcess } from "../bigdata-process.js";

const fixture = new URL("../../../../scripts/fixtures/bigdata-worker.mjs", import.meta.url);
describe("통계 프로세스 격리", () => {
  it("실제 자식의 충돌을 격리하고 다음 조회에서 다시 시작한다", async () => {
    const store = new BigDataProcess("unused", 3000, {}, fixture);
    try {
      const signal = new AbortController().signal;
      await expect(store.query("SELECT", signal)).resolves.toEqual([{ value: 9007199254740993n }]);
      await expect(store.query("CRASH", signal)).rejects.toThrow("통계 엔진이 중단");
      await expect(store.query("SELECT", signal)).resolves.toEqual([{ value: 9007199254740993n }]);
    } finally { store.close(); }
  });
  it("응답 없는 조회도 취소되며 새 조회를 막지 않는다", async () => {
    const store = new BigDataProcess("unused", 3000, {}, fixture);
    try {
      const ac = new AbortController();
      const pending = store.query("HANG", ac.signal);
      const check = expect(pending).rejects.toThrow();
      ac.abort();
      await check;
      await expect(store.query("SELECT", new AbortController().signal)).resolves.toHaveLength(1);
    } finally { store.close(); }
  });
});
