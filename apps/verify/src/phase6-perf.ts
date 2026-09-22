/**
 * Phase 6 — 성능 / 부하 테스트.
 *
 * 100 / 500 / 1000회 반복 + 동시 요청으로 각 계층의 처리량과 지연을 실측하고,
 * 메모리·CPU 사용량과 프로바이더 비용을 함께 기록해 병목을 찾는다.
 *
 * 설계 원칙: LLM 호출은 부하 대상에서 분리한다.
 *  - LLM 지연(수 초)이 우리 코드의 마이크로초 단위 병목을 완전히 가려버리기 때문.
 *  - LLM 경로는 별도로 소규모 동시성만 측정(비용과 rate limit 때문).
 * 따라서 1000회 부하는 우리가 제어하는 계층(STM/LTM/RAG/도구/프롬프트 조립)에 건다.
 */
import { cpuUsage, memoryUsage } from "node:process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assemblePrompt } from "@aios/ai";
import type { ChatMessage } from "@aios/shared";
import { CodeRetriever, Indexer } from "@aios/indexer";
import { DEFAULT_POLICY, ToolExecutor, ToolRegistry, readFileTool, writeFileTool } from "@aios/tools";
import { Report } from "./report.js";
import { createHarness, hashEmbedder } from "./harness.js";
import { TempWorkspaceRegistry } from "./temp-workspaces.js";

const r = new Report("PHASE 6 — Performance & load");
const h = await createHarness();

interface Stats { n: number; expected: number; p50: number; p95: number; p99: number; max: number; rps: number; errors: number; lastError?: Error }

function stats(samples: number[], wallMs: number, errors: number, expected: number): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
  return {
    n: samples.length, expected, p50: at(0.5), p95: at(0.95), p99: at(0.99),
    max: s[s.length - 1] ?? 0, rps: Math.round((samples.length / wallMs) * 1000), errors,
  };
}

/** concurrency 만큼 동시에, 총 total 회 실행 */
async function load(total: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<Stats> {
  const samples: number[] = [];
  let errors = 0;
  let next = 0;
  // 마지막 오류를 보존한다. 전부 실패하면 표본이 0이 되어 "p50=0ms"라는 무의미한 숫자만
  // 남는데, 그러면 '느린 것'과 '아무것도 실행되지 않은 것'을 구분할 수 없다.
  let lastError: Error | undefined;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        const s = Date.now();
        try {
          await fn(i);
          samples.push(Date.now() - s);
        } catch (err) {
          errors++;
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }),
  );
  return { ...stats(samples, Date.now() - t0, errors, total), lastError };
}

/**
 * 표본이 기대치만큼 모였는가.
 *
 * 왜 별도 헬퍼인가: 부하 측정 단언은 대부분 `p95 < X` 형태라 **상한만 본다.**
 * 그런데 한 건도 실행되지 않으면 p95 는 0 이고 errors 도 0 이라 그대로 통과한다 —
 * "매우 빠름"과 "아무것도 안 함"이 같은 초록색이 된다.
 * load() 가 lastError 를 보존하는 이유가 이것인데, 정작 한 곳에서만 쓰고 있었다.
 * 호출자가 기억해야 하는 규칙은 규칙이 아니므로 여기서 강제한다.
 */
function complete(s: Stats): boolean {
  return s.errors === 0 && s.n === s.expected && s.expected > 0;
}

/**
 * 단언 메시지에 표본 수를 항상 붙인다 — 부분 실행이 숫자에 드러나야 한다.
 *
 * 오류가 있었다면 **원인까지 함께 남긴다.** load() 는 lastError 를 보관하는데
 * 정작 단언 메시지에 찍지 않아, 실패했을 때 `err=1` 만 보이고 왜 실패했는지
 * 알 방법이 없었다(실제로 LLM 스트림 12개 중 1개가 죽었는데 원인을 알 수 없었다).
 * 실패 메시지가 원인을 말하지 않으면 다음 사람이 처음부터 다시 재현해야 한다.
 */
function evidence(s: Stats): string {
  const base = `n=${s.n}/${s.expected} err=${s.errors}`;
  return s.errors > 0 && s.lastError ? `${base} lastError="${s.lastError.message.slice(0, 160)}"` : base;
}

function row(label: string, s: Stats): string {
  return `${label.padEnd(30)} n=${String(s.n).padStart(5)} p50=${String(s.p50).padStart(5)}ms ` +
    `p95=${String(s.p95).padStart(5)}ms p99=${String(s.p99).padStart(5)}ms max=${String(s.max).padStart(5)}ms ` +
    `${String(s.rps).padStart(6)} rps err=${s.errors}`;
}

const baselineMem = memoryUsage().heapUsed;
const baselineCpu = cpuUsage();


/*
 * 검증이 만든 임시 디렉터리를 등록해 두고 종료할 때 지운다.
 *
 * 실측: 정리하지 않은 채 반복 실행해 63개가 쌓여 있었다. 개당 240KB 라 당장은 작지만,
 * 사용자의 제약이 "산출물은 T7 에만, 맥에는 두지 않는다" 이고 tmpdir 은 맥 APFS 다.
 * 검증이 자기 흔적을 남기지 않는 것이 기본이다.
 */
const tempWorkspaces = new TempWorkspaceRegistry();
async function tempDir(prefix: string): Promise<string> {
  return tempWorkspaces.create(prefix);
}
async function cleanupTempDirs(): Promise<void> {
  await tempWorkspaces.cleanup();
}

try {
  // ---------- 6.1 STM (Redis) — 1000회 ----------
  r.section("6.1 Short-term memory (Redis) — 1000 ops");
  {
    const sid = randomUUID();
    const s = await load(1000, 50, async (i) => {
      await h.memory.record(sid, { role: i % 2 ? "user" : "assistant", content: `load message ${i} with some padding text` });
    });
    console.log("  " + row("stm.append x1000 (c=50)", s));
    r.check("perf.stm_append", complete(s) && s.p95 < 50, `p95=${s.p95}ms, ${s.rps} rps, ${evidence(s)}`);

    const readStats = await load(500, 50, async () => { await h.memory.stm.getWindow(sid); });
    console.log("  " + row("stm.getWindow x500 (c=50)", readStats));
    // 윈도우가 1000개 메시지로 커진 상태의 읽기 — O(n) 특성을 드러낸다
    r.check("perf.stm_read_large_window", readStats.errors === 0,
      `p50=${readStats.p50}ms p95=${readStats.p95}ms on a 1000-message window`);
  }

  // ---------- 6.2 LTM (pgvector) — 500 write + 1000 recall ----------
  r.section("6.2 Long-term memory (pgvector)");
  const scope = { orgId: h.orgId, userId: h.userId };
  {
    const topics = ["database", "caching", "deployment", "testing", "security", "networking", "frontend", "billing"];
    const w = await load(500, 20, async (i) => {
      await h.memory.ltm.remember(scope, {
        kind: "fact",
        content: `Fact ${i}: the ${topics[i % topics.length]} subsystem uses approach number ${i} with configuration ${i * 7}.`,
        importance: (i % 10) / 10,
      });
    });
    console.log("  " + row("ltm.remember x500 (c=20)", w));
    r.check("perf.ltm_write", w.errors === 0, `p95=${w.p95}ms, ${w.rps} rps`);

    const { rows } = await h.pool.query<{ n: string }>(`select count(*)::text as n from memory_items where org_id=$1`, [h.orgId]);
    console.log(`  (corpus size: ${rows[0]!.n} vectors)`);

    /*
     * recall 은 '질의 임베딩 + 벡터 검색' 두 구간이다.
     * 이걸 한 덩어리로 재고 500ms 를 걸어 두면, 실제로는 **임베더의 처리량**을 재게 된다.
     * 실측(로컬 bge-m3, CPU): 임베딩 단건 62ms / pgvector 검색 2ms.
     * 동시성 25면 Ollama 가 직렬화돼 임베딩만 800ms 를 넘긴다 — 우리 코드는 그대로인데
     * 임베더를 OpenAI에서 로컬로 바꿨다는 이유만으로 성능 게이트가 빨간불이 된다.
     *
     * 그래서 **우리가 책임지는 구간(벡터 검색)에 게이트를 걸고**,
     * 임베더 구간은 환경 특성으로 따로 계측해 출력한다. 숨기지 않되 합치지도 않는다.
     */
    const queries = topics.map((t) => `how do we handle ${t}?`);
    const eMark = await load(queries.length * 4, 25, async (i) => {
      await h.embed([queries[i % queries.length]!]);
    });
    console.log("  " + row(`embed x${queries.length * 4} (c=25, 환경 특성)`, eMark));

    const vectors = await h.embed(queries);
    const rc = await load(1000, 25, async (i) => {
      await h.memory.ltm.recallByVector(scope, vectors[i % vectors.length]!, 8);
    });
    console.log("  " + row("ltm.recall x1000 (c=25, 임베딩 제외)", rc));
    r.check("perf.ltm_recall", complete(rc) && rc.p95 < 500,
      `p50=${rc.p50}ms p95=${rc.p95}ms p99=${rc.p99}ms over ${rows[0]!.n} vectors, ${evidence(rc)} ` +
      `(질의 임베딩 제외 — 임베더 p95=${eMark.p95}ms 는 별도 계측)`);
  }

  // ---------- 6.3 RAG 검색 (하이브리드) ----------
  r.section("6.3 Hybrid RAG retrieval");
  {
    const embed = hashEmbedder(h.embedDim ?? undefined);
    const dir = await tempDir("aios-perf-");
    // 합성 코드베이스: 파일 60개 × ~120줄
    for (let f = 0; f < 60; f++) {
      const lines: string[] = [`// module ${f}`];
      for (let i = 0; i < 12; i++) {
        lines.push(
          `export function handler${f}_${i}(input: string): string {`,
          `  const normalized = input.trim().toLowerCase();`,
          `  if (normalized.length === 0) return "empty";`,
          `  return normalized + "-${f}-${i}";`,
          `}`, "",
        );
      }
      await writeFile(join(dir, `mod${f}.ts`), lines.join("\n"));
    }
    const { rows: pr } = await h.pool.query<{ id: string }>(
      `insert into projects (org_id, name) values ($1,'perf') returning id`, [h.orgId]);
    const projectId = pr[0]!.id;

    const t0 = Date.now();
    const res = await new Indexer(h.pool, embed).indexProject(projectId, dir);
    const indexMs = Date.now() - t0;
    const { rows: cr } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from code_chunks where project_id=$1`, [projectId]);
    console.log(`  index: ${res.added} files → ${cr[0]!.n} chunks in ${indexMs}ms (${Math.round((res.added / indexMs) * 1000)} files/s)`);
    r.check("perf.index_throughput", res.added === 60 && indexMs < 60_000, `${res.added} files, ${cr[0]!.n} chunks, ${indexMs}ms`);

    const retriever = new CodeRetriever(h.pool, embed);
    const s = await load(300, 20, async (i) => { await retriever.retrieve(projectId, `handler${i % 60} normalize input`, 8); });
    console.log("  " + row("rag.retrieve x300 (c=20)", s));
    r.check("perf.rag_retrieve", complete(s) && s.p95 < 800,
      `p50=${s.p50}ms p95=${s.p95}ms over ${cr[0]!.n} chunks`);

    // 증분 인덱싱 이득 측정 — 전량 재인덱싱 대비 얼마나 싼가
    const t1 = Date.now();
    const res2 = await new Indexer(h.pool, embed).indexProject(projectId, dir);
    const rescanMs = Date.now() - t1;
    console.log(`  incremental rescan: ${rescanMs}ms (${Math.round((1 - rescanMs / indexMs) * 100)}% cheaper), changed=${res2.added + res2.updated}`);
    r.check("perf.incremental_saves", res2.added === 0 && res2.updated === 0 && rescanMs < indexMs,
      `${indexMs}ms → ${rescanMs}ms with zero re-embedding`);
  }

  // ---------- 6.4 프롬프트 조립 (CPU 바운드) ----------
  r.section("6.4 Prompt assembly (CPU-bound)");
  {
    const facts = Array.from({ length: 40 }, (_, i) => `[fact] The system component ${i} behaves in a particular way under load.`);
    const chunks = Array.from({ length: 20 }, (_, i) => `// file${i}.ts:1-40\n${"export const x = 1;\n".repeat(30)}`);
    const history: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `Message ${i}: ${"context ".repeat(40)}`,
    }));
    const s = await load(1000, 1, async () => {
      assemblePrompt({ systemCore: "core", memoryFacts: facts, ragChunks: chunks, stmSummary: "summary", history, userMessage: "q", budgetTokens: 40_000 });
    });
    console.log("  " + row("assemblePrompt x1000", s));
    r.check("perf.prompt_assembly", complete(s) && s.p99 < 50,
      `p50=${s.p50}ms p99=${s.p99}ms — ${s.rps} assemblies/s single-threaded, ${evidence(s)}`);
  }

  // ---------- 6.5 도구 실행 ----------
  r.section("6.5 Tool execution (fs)");
  {
    const dir = await tempDir("aios-tool-perf-");
    await writeFile(join(dir, "target.ts"), "export const value = 1;\n".repeat(200));
    const reg = new ToolRegistry();
    reg.register(readFileTool);
    reg.register(writeFileTool);
    const exe = new ToolExecutor(reg, DEFAULT_POLICY); // 감사 로그 없이 순수 실행 비용
    const ctx = { orgId: h.orgId, sessionId: "perf", projectRoot: dir };
    const s = await load(1000, 25, async (i) => {
      const result = await exe.execute(ctx, { id: `t${i}`, name: "read_file", arguments: { path: "target.ts" } });
      // ToolExecutor는 도구 실패를 소프트 결과로 돌려준다. ok를 확인하지 않으면
      // 1000번 모두 jail 오류여도 load()는 성공 표본 1000개로 잘못 센다.
      if (!result.ok || !result.output.includes("export const value")) {
        throw new Error(`read_file did not return the fixture: ${result.output.slice(0, 160)}`);
      }
    });
    console.log("  " + row("tool.read_file x1000 (c=25)", s));
    r.check("perf.tool_exec", complete(s) && s.p95 < 100, `p50=${s.p50}ms p95=${s.p95}ms, ${s.rps} rps, ${evidence(s)}`);
  }

  // ---------- 6.6 LLM 동시성 + TTFT/TPS (실비용) ----------
  r.section("6.6 LLM concurrency, TTFT & TPS (real cost)");
  await r.guard("llm", async () => {
    // 프로바이더 무관 시험인데 특정 키에 묶여 있었다 — phase7 과 같은 실수.
    const hasProvider = Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY || process.env.XAI_API_KEY || process.env.LOCAL_LLM_BASE_URL,
    );
    if (!hasProvider) { r.check("perf.llm_concurrency", false, "no provider key"); return; }
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    const ttfts: number[] = [];
    const tps: number[] = [];

    const s = await load(12, 6, async (i) => {
      const t0 = Date.now();
      let ttft = 0;
      let outTokens = 0;
      let firstTokenAt = 0;
      for await (const ev of h.router.stream(
        // 출력 토큰이 충분해야 TPS가 의미를 갖는다 — 한 단어 응답으로는 측정 불가.
        { messages: [{ role: "user", content: `Write exactly 80 words about topic number ${i}. Plain prose.` }], maxTokens: 2048 },
        { taskClass: "cheap" },
      )) {
        if (ev.type === "text_delta" && ttft === 0) {
          ttft = Date.now() - t0;
          firstTokenAt = Date.now();
        }
        if (ev.type === "usage") {
          outTokens = ev.usage.outputTokens;
          totalCost += ev.usage.costUsd ?? 0;
          totalIn += ev.usage.inputTokens;
          totalOut += ev.usage.outputTokens;
        }
      }
      if (ttft > 0) {
        ttfts.push(ttft);
        // TPS = 첫 토큰 이후의 생성 속도. 첫 토큰까지의 대기(TTFT)를 포함하면
        // 프롬프트 처리 시간이 생성 속도로 잘못 계산된다.
        const genMs = Math.max(1, Date.now() - firstTokenAt);
        tps.push((outTokens / genMs) * 1000);
      }
    });

    const pct = (arr: number[], q: number) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(a.length * q))] ?? 0;
    };
    console.log("  " + row("llm.stream x12 (c=6)", s));
    console.log(`  TTFT: p50=${pct(ttfts, 0.5)}ms p95=${pct(ttfts, 0.95)}ms  |  TPS: p50=${pct(tps, 0.5).toFixed(1)} tok/s p95=${pct(tps, 0.95).toFixed(1)} tok/s`);
    console.log(`  cost: $${totalCost.toFixed(5)} for ${totalIn} in / ${totalOut} out tokens ($${(totalCost / 12).toFixed(6)}/req)`);

    // 표본이 하나도 없다면 측정이 아니라 차단이다 — 던져서 guard가 원인을 분류하게 한다.
    if (s.n === 0 && s.lastError) throw s.lastError;
    r.check("perf.llm_concurrency", complete(s), `p50=${s.p50}ms p95=${s.p95}ms, no failures at c=6, ${evidence(s)}`);
    r.check("perf.ttft_measured", ttfts.length === 12 && pct(ttfts, 0.5) > 0,
      `TTFT p50=${pct(ttfts, 0.5)}ms p95=${pct(ttfts, 0.95)}ms over ${ttfts.length}/12 streams, ${evidence(s)}`);
    r.check("perf.tps_measured", tps.length === 12 && pct(tps, 0.5) > 1,
      `generation throughput p50=${pct(tps, 0.5).toFixed(1)} tok/s over ${tps.length}/12 streams ` +
      `(measured after first token, excluding TTFT), ${evidence(s)}`);
    r.check("perf.llm_dominates_latency", s.p50 > 200,
      `LLM p50=${s.p50}ms vs our slowest local layer — confirms inference is the dominant cost`);
  });

  // ---------- 6.7 리소스 사용량 ----------
  r.section("6.7 Resource usage");
  {
    global.gc?.();
    const mem = memoryUsage();
    const cpu = cpuUsage(baselineCpu);
    const heapGrowthMb = (mem.heapUsed - baselineMem) / 1024 / 1024;
    console.log(`  heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB used / ${(mem.rss / 1024 / 1024).toFixed(1)} MB rss (growth ${heapGrowthMb.toFixed(1)} MB)`);
    console.log(`  cpu:  ${(cpu.user / 1000).toFixed(0)}ms user / ${(cpu.system / 1000).toFixed(0)}ms system`);
    r.check("perf.memory_bounded", mem.heapUsed / 1024 / 1024 < 600,
      `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB heap after ~4800 operations`);
    r.check("perf.no_runaway_growth", heapGrowthMb < 400, `heap grew ${heapGrowthMb.toFixed(1)} MB across the whole run`);

    // DB 커넥션 풀이 고갈되지 않았는지 (병목 #5)
    const { rows } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity where datname = current_database()`);
    console.log(`  postgres connections in use: ${rows[0]!.n}`);
    r.check("perf.pool_not_exhausted", Number(rows[0]!.n) < 50, `${rows[0]!.n} connections (pool max 8 per process)`);
  }
} finally {
  await cleanupTempDirs();
  await h.close();
}

r.finish();
