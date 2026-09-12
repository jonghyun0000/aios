/**
 * Phase 2 회귀: STM 예산 계산에 rolling summary가 포함되는가.
 *
 * 버그: getWindow().approxTokens 가 메시지 토큰만 세고 summary를 빠뜨렸다.
 * 요약이 누적될수록 실제 프롬프트 사용량이 예산을 조용히 초과한다 —
 * 압축이 트리거되지 않아 결국 컨텍스트 초과로 요청이 실패한다.
 */
import { describe, expect, it } from "vitest";
import { estimateTokens } from "@aios/shared";
import { ShortTermMemory } from "../short-term.js";

/** Redis의 최소 표면만 구현한 인메모리 스텁 — 실제 Redis 없이 예산 로직만 검증 */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const strings = new Map<string, string>();
  const api = {
    async lrange(key: string, start: number, stop: number) {
      const l = lists.get(key) ?? [];
      return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async del(...keys: string[]) {
      for (const k of keys) { lists.delete(k); strings.delete(k); }
      return keys.length;
    },
    pipeline() {
      const ops: (() => void)[] = [];
      const p = {
        rpush(key: string, v: string) { ops.push(() => { lists.set(key, [...(lists.get(key) ?? []), v]); }); return p; },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => { const l = lists.get(key) ?? []; lists.set(key, stop === -1 ? l.slice(start) : l.slice(start, stop + 1)); });
          return p;
        },
        set(key: string, v: string) { ops.push(() => { strings.set(key, v); }); return p; },
        expire() { return p; },
        async exec() { for (const op of ops) op(); return []; },
      };
      return p;
    },
  };
  return api as unknown as ConstructorParameters<typeof ShortTermMemory>[0];
}

describe("STM 토큰 예산", () => {
  it("summary 토큰을 예산에 포함한다", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 4000 }); // summary 예산 1200
    await stm.append("s1", { role: "user", content: "short message" });

    const before = await stm.getWindow("s1");
    await stm.append("s1", { role: "assistant", content: "a" });
    await stm.append("s1", { role: "user", content: "b" });
    await stm.append("s1", { role: "assistant", content: "c" });
    // 예산 안에 들어오는 요약이므로 그대로 저장되어야 한다
    const summary = "summary text ".repeat(100);
    await stm.compact("s1", async () => summary);

    const after = await stm.getWindow("s1");
    expect(after.summary).toBe(summary);
    // 핵심: approxTokens가 summary를 포함해야 한다 (빠뜨리면 예산 초과를 감지 못 한다)
    expect(after.approxTokens).toBeGreaterThanOrEqual(estimateTokens(summary));
    expect(after.approxTokens).toBeGreaterThan(before.approxTokens);
  });

  it("summary가 커지면 예산 소모가 커지되 상한을 넘지 않는다", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 1000 }); // summary 예산 300
    for (const c of ["aaaa", "bbbb", "cccc", "dddd"]) await stm.append("s2", { role: "user", content: c });
    const before = (await stm.getWindow("s2")).approxTokens;

    await stm.compact("s2", async () => "x ".repeat(2000)); // 예산을 크게 넘는 요약
    const after = await stm.getWindow("s2");

    expect(after.approxTokens).toBeGreaterThan(before);
    expect(estimateTokens(after.summary ?? "")).toBeLessThanOrEqual(stm.summaryTokenBudget);
  });

  it("메시지가 4개 미만이면 압축하지 않는다 (요약할 것이 없다)", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 10 });
    await stm.append("s3", { role: "user", content: "only one" });
    let called = false;
    await stm.compact("s3", async () => { called = true; return "s"; });
    expect(called).toBe(false);
  });
});

/**
 * Sprint 2 회귀: 압축 스래싱.
 *
 * 버그: 요약이 예산보다 커지면 압축이 임계를 영원히 해소하지 못해 매 턴 요약 LLM이
 * 호출됐다(500턴 스트레스에서 491회 — 턴당 1회꼴). 비용과 지연이 조용히 폭증한다.
 */
describe("압축 스래싱 방지", () => {
  it("요약이 예산을 넘게 반환돼도 STM이 잘라낸다", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 1000 }); // summary 예산 300
    for (let i = 0; i < 8; i++) await stm.append("t1", { role: "user", content: `message ${i}` });

    // 주입된 요약 함수가 예산을 완전히 무시하고 거대한 문자열을 돌려준다
    await stm.compact("t1", async () => "OVERSIZED ".repeat(2000));

    const w = await stm.getWindow("t1");
    expect(estimateTokens(w.summary ?? "")).toBeLessThanOrEqual(stm.summaryTokenBudget);
    expect(w.summary).toContain("summary truncated");
    // 요약 앞부분(결론이 오는 자리)은 보존된다
    expect(w.summary!.startsWith("OVERSIZED")).toBe(true);
  });

  it("거대 요약을 반복 반환해도 압축 신호가 영구히 켜져 있지 않다", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 1000 });
    for (let i = 0; i < 12; i++) {
      await stm.append("t2", { role: "user", content: `a fairly long message number ${i} with padding text to consume budget` });
    }

    // 매번 예산을 무시하는 요약기로 최대 5회까지 압축을 시도한다.
    let cycles = 0;
    while (await stm.needsCompaction("t2")) {
      cycles++;
      if (cycles > 5) break; // 무한 루프 방지 — 이 지점에 도달하면 스래싱이 살아있다는 뜻
      await stm.compact("t2", async () => "HUGE ".repeat(3000));
    }

    expect(cycles).toBeLessThanOrEqual(5);
    const w = await stm.getWindow("t2");
    expect(w.approxTokens).toBeLessThanOrEqual(1000);
  });

  it("summaryBudgetRatio가 요약 예산을 결정한다", () => {
    expect(new ShortTermMemory(fakeRedis(), { maxTokens: 8000 }).summaryTokenBudget).toBe(2400);
    expect(new ShortTermMemory(fakeRedis(), { maxTokens: 8000, summaryBudgetRatio: 0.1 }).summaryTokenBudget).toBe(800);
  });

  it("메시지가 부족하면 토큰이 넘쳐도 압축 신호를 내지 않는다 (스래싱의 직접 원인)", async () => {
    const stm = new ShortTermMemory(fakeRedis(), { maxTokens: 50 });
    // 메시지 3개만으로 예산을 크게 초과시킨다
    for (let i = 0; i < 3; i++) await stm.append("t3", { role: "user", content: "x".repeat(400) });
    const w = await stm.getWindow("t3");
    expect(w.approxTokens).toBeGreaterThan(50);
    // 압축해도 줄일 수 없는 상태이므로 신호를 내면 안 된다
    expect(await stm.needsCompaction("t3")).toBe(false);
  });
});
