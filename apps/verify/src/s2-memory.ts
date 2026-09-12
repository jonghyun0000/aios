/**
 * Sprint 2 · Step 3 — Memory Stress Test.
 *
 * 100 / 300 / 500회 자동 생성 대화로 STM·LTM·Recall·Compression·Ranking·Summary·
 * Context Injection을 검증하고, 메모리 누수(heap 증가 추세)를 확인한다.
 *
 * 누수 판정 방법: 각 라운드 후 강제 GC → heapUsed 측정 → 라운드 간 증가율을 본다.
 * 단발 스냅샷은 GC 타이밍에 좌우되므로, '작업량이 5배가 되어도 heap이 5배가 되지 않는다'는
 * 관계를 본다. 캐시가 있는 시스템에서 heap이 조금 느는 것은 정상이고, 선형 증가가 문제다.
 */
import { randomUUID } from "node:crypto";
import { assemblePrompt } from "@aios/ai";
import { estimateTokens } from "@aios/shared";
import type { ChatMessage } from "@aios/shared";
import { Report } from "./report.js";
import { createHarness } from "./harness.js";

const r = new Report("SPRINT 2 · STEP 3 — Memory stress");
const h = await createHarness();
const scope = { orgId: h.orgId, userId: h.userId };

/** 결정론적 합성 대화 — LLM 호출 없이 대량 생성 가능해야 500회가 현실적이다 */
const TOPICS = ["database", "caching", "deployment", "testing", "security", "networking", "frontend", "billing", "observability", "migrations"];
function syntheticTurn(i: number): ChatMessage[] {
  const topic = TOPICS[i % TOPICS.length]!;
  return [
    { role: "user", content: `Turn ${i}: how should we handle ${topic} in this project? Consider the tradeoffs carefully and be specific about the constraints that apply here.` },
    { role: "assistant", content: `For ${topic} we should use approach ${i % 7} because it balances latency against operational cost, and it keeps the failure mode observable. Decision recorded for turn ${i}.` },
  ];
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/**
 * GC를 강제하고 안정될 때까지 기다린 뒤 heap을 잰다.
 *
 * --expose-gc 없이는 이 측정이 성립하지 않는다: heapUsed에 '보유 중인 메모리'와
 * '아직 수거되지 않은 쓰레기'가 섞여 있어 누수를 판별할 수 없다.
 * 실측 차이 — 강제 GC 있음 623 bytes/turn, 없음 10,558 bytes/turn (같은 코드).
 * 그래서 GC가 없으면 이 항목을 게이트가 아니라 관측으로 낮춘다.
 */
const GC_AVAILABLE = typeof global.gc === "function";

async function settledHeap(): Promise<number> {
  global.gc?.();
  await new Promise((res) => setTimeout(res, 250));
  global.gc?.();
  await new Promise((res) => setTimeout(res, 250));
  return heapMb();
}

interface RoundResult {
  turns: number;
  sessionId: string;
  stmMessages: number;
  stmTokens: number;
  compactions: number;
  summaryLen: number;
  ltmRows: number;
  heapMb: number;
  wallMs: number;
}

const rounds: RoundResult[] = [];
const baselineHeap = await settledHeap();
console.log(`  baseline heap: ${baselineHeap.toFixed(1)} MB`);

try {
  for (const turns of [100, 300, 500]) {
    r.section(`3.x — ${turns}-turn conversation`);
    const sessionId = randomUUID();
    const t0 = Date.now();
    let compactions = 0;

    for (let i = 0; i < turns; i++) {
      for (const m of syntheticTurn(i)) await h.memory.record(sessionId, m);

      // 실제 운영과 동일하게: 임계 초과 시 압축한다. 요약은 결정론적 스텁을 쓴다 —
      // 500회에 LLM 요약을 붙이면 수십 달러와 수십 분이 들고, 검증 대상(압축 '기전')과 무관하다.
      if (await h.memory.stm.needsCompaction(sessionId)) {
        await h.memory.stm.compact(sessionId, async (existing, msgs) => {
          compactions++;
          const decisions = msgs
            .map((m) => /Decision recorded for turn (\d+)/.exec(m.content)?.[1])
            .filter(Boolean);
          // 의도적으로 예산보다 큰 요약을 반환한다 — STM이 이를 잘라내는지 검증하기 위함.
          // (요약 함수는 주입된 코드이므로, 그것을 신뢰하지 않는 것이 STM의 계약이다.)
          return `${existing ?? ""} [compacted ${msgs.length} msgs; decisions: ${decisions.join(",")}]`.trim();
        });
      }
    }

    const window = await h.memory.stm.getWindow(sessionId);
    const heap = await settledHeap();
    const { rows } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from memory_items where org_id=$1`, [h.orgId]);

    const round: RoundResult = {
      turns, sessionId,
      stmMessages: window.messages.length,
      stmTokens: window.approxTokens,
      compactions,
      summaryLen: window.summary?.length ?? 0,
      ltmRows: Number(rows[0]!.n),
      heapMb: heap,
      wallMs: Date.now() - t0,
    };
    rounds.push(round);

    console.log(`    ${turns} turns in ${round.wallMs}ms — STM ${round.stmMessages} msgs / ${round.stmTokens} tok, ` +
      `${compactions} compactions, summary ${round.summaryLen} chars, heap ${heap.toFixed(1)} MB`);

    // --- STM 불변식 ---
    r.check(`stm.bounded@${turns}`, round.stmTokens <= 500 * 1.5,
      `window held at ${round.stmTokens} tokens against a 500-token budget after ${turns * 2} messages`);
    r.check(`stm.compaction_triggered@${turns}`, compactions > 0, `${compactions} compaction cycles ran`);
    r.check(`stm.summary_grows_not_unbounded@${turns}`, round.summaryLen > 0 && round.summaryLen <= 4000,
      `summary ${round.summaryLen} chars (capped)`);
    r.check(`stm.window_smaller_than_input@${turns}`, round.stmMessages < turns * 2,
      `${round.stmMessages} messages retained out of ${turns * 2} written`);
  }

  // ---------- 누수 판정 ----------
  r.section("3.4 Memory leak analysis");
  {
    const [r100, r300, r500] = rounds as [RoundResult, RoundResult, RoundResult];
    const totalTurns = rounds.reduce((s, x) => s + x.turns, 0);
    const growthMb = r500.heapMb - baselineHeap;
    const bytesPerTurn = (growthMb * 1024 * 1024) / totalTurns;

    console.log(`    heap: baseline ${baselineHeap.toFixed(1)} → 100t ${r100.heapMb.toFixed(1)} → 300t ${r300.heapMb.toFixed(1)} → 500t ${r500.heapMb.toFixed(1)} MB`);
    console.log(`    growth: +${growthMb.toFixed(2)} MB over ${totalTurns} turns = ${bytesPerTurn.toFixed(0)} bytes/turn`);

    // '5배 작업에 힙 몇 배'라는 비율은 분모가 작으면(수십 KB) 노이즈가 증폭돼 무작위로 실패한다
    // (실측: 같은 코드가 1.00x와 6.80x를 오갔다). 턴당 절대 증가량이 누수의 직접적 정의이고
    // 측정도 안정적이다. 세션당 유지되는 상태는 상수 크기여야 하므로 4KB/턴을 상한으로 잡는다.
    if (GC_AVAILABLE) {
      r.check("leak.no_per_turn_accumulation", bytesPerTurn < 4096,
        `${bytesPerTurn.toFixed(0)} bytes retained per turn across ${totalTurns} turns — bounded, so nothing accumulates`);
    } else {
      console.log(`    NOTE: run with --expose-gc to gate on this. Without forced GC the figure ` +
        `(${bytesPerTurn.toFixed(0)} B/turn) mixes retained memory with uncollected garbage and cannot show a leak.`);
      r.check("leak.measurement_possible", false,
        "heap-leak gate skipped: --expose-gc not enabled (use `pnpm --filter @aios/verify s2:memory`)");
    }
    r.check("leak.absolute_bounded", r500.heapMb < 400,
      `${r500.heapMb.toFixed(1)} MB heap after ${rounds.reduce((s, x) => s + x.turns, 0)} turns`);

    // Redis 쪽 누수: 세션 키가 예산만큼만 유지되는가
    const keys = await h.redis.keys("{stm:*}*");
    const sizes = await Promise.all(
      rounds.map(async (x) => Number(await h.redis.llen(`{stm:${x.sessionId}}:msgs`))),
    );
    console.log(`    redis: ${keys.length} STM keys, list lengths ${sizes.join(", ")}`);
    r.check("leak.redis_lists_bounded", sizes.every((s) => s < 200),
      `no session list exceeded 200 entries despite 200/600/1000 appends: ${sizes.join(", ")}`);

    // PG 커넥션 누수
    const { rows: conn } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity where datname = current_database()`);
    r.check("leak.pg_connections_stable", Number(conn[0]!.n) <= 20,
      `${conn[0]!.n} postgres connections after the full run (pool max 8)`);
  }

  // ---------- LTM: 대량 적재 후 recall 품질 ----------
  r.section("3.5 LTM at scale");
  await r.guard("ltm", async () => {
    // 서로 구별되는 500개 사실 + 의도적 중복 100개
    const t0 = Date.now();
    for (let i = 0; i < 500; i++) {
      await h.memory.ltm.remember(scope, {
        kind: "fact",
        content: `Fact ${i}: the ${TOPICS[i % TOPICS.length]} subsystem uses configuration variant ${i} with threshold ${i * 13}.`,
        importance: (i % 10) / 10,
      });
    }
    const writeMs = Date.now() - t0;

    let deduped = 0;
    for (let i = 0; i < 100; i++) {
      const res = await h.memory.ltm.remember(scope, {
        kind: "fact",
        content: `Fact ${i}: the ${TOPICS[i % TOPICS.length]} subsystem uses configuration variant ${i} with threshold ${i * 13}.`,
        importance: 0.5,
      });
      if (res.deduped) deduped++;
    }

    const { rows } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from memory_items where org_id=$1`, [h.orgId]);
    console.log(`    wrote 500 facts in ${writeMs}ms; 100 duplicates → ${deduped} deduped; corpus ${rows[0]!.n} rows`);

    r.check("ltm.dedupe_at_scale", deduped >= 95,
      `${deduped}/100 exact duplicates were merged instead of inserted`);
    /*
     * 상한만 보면 안 된다. 실제로 임계값이 느슨해 서로 다른 사실 500개가 39행으로
     * 뭉개졌을 때, 이 단언은 그대로 통과했다 — 데이터가 사라졌는데 "중복 제거 성공"으로 읽혔다.
     * 과소 병합은 잡음이지만 과다 병합은 소실이므로 하한을 더 세게 본다.
     */
    const corpus = Number(rows[0]!.n);
    r.check("ltm.corpus_size_correct", corpus >= 495 && corpus <= 520,
      `${corpus} rows for 600 writes (distinct 500) — 중복은 늘리지 않고 서로 다른 사실은 지우지 않았다`);

    // recall이 대량 코퍼스에서도 관련 항목을 상위에 올리는가
    const hits = await h.memory.ltm.recall(scope, "configuration variant 42 threshold", 10);
    r.check("ltm.recall_finds_target", hits.some((x) => /variant 42\b/.test(x.content)),
      `top-10 for a specific fact: ${hits.slice(0, 3).map((x) => x.content.slice(0, 40)).join(" | ")}`);
    r.check("ltm.recall_scored_and_sorted",
      hits.every((x, i) => i === 0 || (hits[i - 1]!.score ?? 0) >= (x.score ?? 0)),
      `scores: ${hits.slice(0, 5).map((x) => x.score?.toFixed(3)).join(", ")}`);

    // 랭킹: 중요도 높은 항목이 동일 관련성에서 우선하는가
    await h.memory.ltm.remember(scope, { kind: "decision", content: "Ranking probe: the caching layer must use write-through, not write-back.", importance: 0.95 });
    await h.memory.ltm.remember(scope, { kind: "fact", content: "Ranking probe: the caching layer once considered write-back and rejected it.", importance: 0.05 });
    const ranked = await h.memory.ltm.recall(scope, "Ranking probe caching layer write-through", 10);
    const hi = ranked.findIndex((x) => /must use write-through/.test(x.content));
    const lo = ranked.findIndex((x) => /once considered/.test(x.content));
    r.check("ltm.ranking_prefers_important", hi !== -1 && (lo === -1 || hi < lo),
      `importance 0.95 at index ${hi}, importance 0.05 at index ${lo}`);
  });

  // ---------- Context injection at scale ----------
  r.section("3.6 Context injection at scale");
  await r.guard("context", async () => {
    const big = rounds[2]!;
    const ctx = await h.memory.buildContext(scope, big.sessionId, "what did we decide about caching?");
    r.check("context.assembled_from_stressed_session",
      ctx.facts.length > 0 && !!ctx.stmSummary && ctx.history.length > 0,
      `${ctx.facts.length} LTM facts, summary ${ctx.stmSummary?.length ?? 0} chars, ${ctx.history.length} history msgs`);

    const assembled = assemblePrompt({
      systemCore: "You are AIOS.",
      memoryFacts: ctx.facts,
      ragChunks: [],
      stmSummary: ctx.stmSummary,
      history: ctx.history,
      userMessage: "what did we decide about caching?",
      budgetTokens: 8000,
    });
    // 상한만 보면 '아무것도 주입되지 않음'(0 토큰)이 통과한다.
    r.check("context.respects_budget_at_scale",
      assembled.usedTokens > 0 && assembled.usedTokens <= 8000,
      `used ${assembled.usedTokens}/8000 tokens; dropped ${JSON.stringify(assembled.dropped)}`);
    r.check("context.system_prompt_contains_all_sections",
      assembled.system.includes("Long-term memory") && assembled.system.includes("Summary of earlier conversation"),
      `system prompt ${estimateTokens(assembled.system)} tokens with memory + summary sections`);

    // 아주 빡빡한 예산에서도 필수 요소는 살아남는가
    const tight = assemblePrompt({
      systemCore: "You are AIOS.",
      memoryFacts: ctx.facts,
      ragChunks: [],
      stmSummary: ctx.stmSummary,
      history: ctx.history,
      userMessage: "q",
      budgetTokens: 200,
    });
    r.check("context.degrades_without_losing_essentials",
      tight.system.includes("You are AIOS.") && tight.messages.at(-1)!.content === "q",
      `at a 200-token budget: dropped ${JSON.stringify(tight.dropped)}`);
  });
} finally {
  await h.close();
}

r.finish();
