/**
 * Phase 2 — Memory Engine 검증.
 * Session(STM) / Long-term(LTM) / Recall / Ranking / Compression / Summarization / Context Injection.
 * 실제 Redis + Postgres(pgvector) + 실제 LLM(요약·추출)에 붙는다.
 */
import { randomUUID } from "node:crypto";
import { assemblePrompt } from "@aios/ai";
import { estimateTokens } from "@aios/shared";
import type { ChatMessage } from "@aios/shared";
import { Report } from "./report.js";
import { createHarness } from "./harness.js";

const r = new Report("PHASE 2 — Memory Engine");
const h = await createHarness();
const scope = { orgId: h.orgId, userId: h.userId };

try {
  // ---------- 2.1 Session Memory (STM) ----------
  r.section("2.1 Session Memory (Redis STM)");
  const sessionId = randomUUID();
  await r.guard("stm", async () => {
    for (let i = 1; i <= 6; i++) {
      await h.memory.record(sessionId, { role: i % 2 ? "user" : "assistant", content: `message number ${i}` });
    }
    const w = await h.memory.stm.getWindow(sessionId);
    r.check("stm.append_order", w.messages.length === 6 && w.messages[0]!.content.endsWith("1") && w.messages[5]!.content.endsWith("6"),
      `${w.messages.length} messages, first="${w.messages[0]?.content}", last="${w.messages[5]?.content}"`);
    r.check("stm.token_accounting", w.approxTokens > 0, `approxTokens=${w.approxTokens}`);

    const ttl = await h.redis.ttl(`{stm:${sessionId}}:msgs`);
    r.check("stm.ttl_set", ttl > 0 && ttl <= 7 * 24 * 3600, `ttl=${ttl}s`);

    // 세션 격리: 다른 세션의 메시지가 새지 않는가
    const other = randomUUID();
    await h.memory.record(other, { role: "user", content: "unrelated" });
    const w2 = await h.memory.stm.getWindow(sessionId);
    r.check("stm.session_isolation", w2.messages.length === 6, `still ${w2.messages.length} after writing to another session`);
  });

  // ---------- 2.2 Compression + Summarization ----------
  r.section("2.2 Compression + Summarization (실제 LLM 요약)");
  const compactSession = randomUUID();
  await r.guard("compaction", async () => {
    const facts = [
      "We decided to use PostgreSQL with pgvector instead of a dedicated vector database, because keeping chunks and metadata in one transaction avoids dual-write consistency problems.",
      "The team agreed the API must stay backwards compatible until v2 ships in Q3, and any breaking change requires a twelve month deprecation window announced in the changelog.",
      "Deployment target is Kubernetes on AWS, with canary releases held at 10 percent for five minutes while error rate and stream interruption rate are watched before going to full traffic.",
      "Rate limiting is enforced per organization rather than per user, so a single noisy user cannot exhaust the quota of their teammates in the same workspace.",
      "The frontend is React with TanStack Query for server state, and we deliberately avoided a global store because most state is server state with a cache policy.",
      "All timestamps are stored in UTC in the database and rendered in the viewer's local timezone at the presentation layer, never converted in between.",
    ];
    for (const f of facts) {
      await h.memory.record(compactSession, { role: "user", content: f });
      await h.memory.record(compactSession, { role: "assistant", content: `Understood, I will remember that. ${f}` });
    }
    const before = await h.memory.stm.getWindow(compactSession);
    const needs = await h.memory.stm.needsCompaction(compactSession);
    r.check("compaction.threshold_detected", needs, `approxTokens=${before.approxTokens} (budget 1200, trigger at 80%)`);

    await h.memory.maybeCompact(compactSession);
    const after = await h.memory.stm.getWindow(compactSession);
    /*
      * 줄어들기만 하면 되는 게 아니다. 전부 날아가도 `after < before` 는 참이다 —
      * 압축과 소실이 같은 초록색이 된다. 최근 대화는 반드시 남아야 하므로 하한을 건다.
      */
    r.check("compaction.window_shrunk",
      after.messages.length < before.messages.length && after.messages.length > 0,
      `${before.messages.length} → ${after.messages.length} messages (전부 소실이 아니다)`);
    r.check("compaction.summary_written", !!after.summary && after.summary.length > 20,
      `summary=${after.summary ? `"${after.summary.slice(0, 90)}..."` : "null"}`);
    // 요약이 실제로 정보를 보존했는가 — 압축은 정보 손실이 목적이 아니다
    const preserved = after.summary ? /postgres|pgvector|kubernetes|canary|utc/i.test(after.summary) : false;
    r.check("compaction.information_preserved", preserved,
      preserved ? "summary retains key decisions" : `summary lost key terms: "${after.summary?.slice(0, 120)}"`);
    r.check("compaction.token_reduction",
      after.approxTokens < before.approxTokens && after.approxTokens > 0,
      `${before.approxTokens} → ${after.approxTokens} tokens (0 이면 압축이 아니라 삭제다)`);
  });

  // ---------- 2.3 Long-term Memory: 저장 + 중복 제거 ----------
  r.section("2.3 Long-term Memory (pgvector)");
  await r.guard("ltm.write", async () => {
    const a = await h.memory.ltm.remember(scope, {
      kind: "preference",
      content: "The user prefers TypeScript with strict mode enabled and no implicit any.",
      importance: 0.8,
    });
    r.check("ltm.insert", !a.deduped && !!a.id, `id=${a.id.slice(0, 8)} deduped=${a.deduped}`);

    // 거의 동일한 문장 → 중복 제거되어야 한다 (신규 insert 금지)
    const b = await h.memory.ltm.remember(scope, {
      kind: "preference",
      content: "The user prefers TypeScript with strict mode enabled and no implicit any.",
      importance: 0.6,
    });
    r.check("ltm.dedupe_identical", b.deduped && b.id === a.id, `deduped=${b.deduped} sameId=${b.id === a.id}`);

    // 명확히 다른 사실 → 신규 저장되어야 한다
    const c = await h.memory.ltm.remember(scope, {
      kind: "decision",
      content: "Billing is handled by Stripe with metered usage reported daily.",
      importance: 0.7,
    });
    r.check("ltm.distinct_not_deduped", !c.deduped, `deduped=${c.deduped}`);

    const { rows } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from memory_items where org_id = $1`, [h.orgId]);
    r.check("ltm.row_count", rows[0]!.n === "2", `${rows[0]!.n} rows (expected 2: 1 deduped + 1 distinct)`);
  });

  // ---------- 2.4 Recall + Ranking ----------
  r.section("2.4 Recall & Ranking");
  await r.guard("ltm.recall", async () => {
    // 랭킹 신호를 분리 검증하기 위해 중요도/최근성이 다른 항목을 심는다
    await h.memory.ltm.remember(scope, {
      kind: "fact", content: "Redis is used for short term memory caching and the job queue.", importance: 0.9,
    });
    await h.memory.ltm.remember(scope, {
      kind: "fact", content: "An old abandoned idea was to use MongoDB for everything.", importance: 0.1,
    });

    const hits = await h.memory.ltm.recall(scope, "Which database do we use for vectors and caching?", 5);
    r.check("recall.returns_results", hits.length > 0, `${hits.length} hits`);
    r.check("recall.scores_present", hits.every((x) => typeof x.score === "number" && x.score > 0),
      `scores=[${hits.map((x) => x.score?.toFixed(3)).join(", ")}]`);
    r.check("recall.sorted_desc", hits.every((x, i) => i === 0 || hits[i - 1]!.score! >= x.score!), "descending by composite score");

    // 랭킹: 높은 중요도 항목이 낮은 중요도 항목보다 위여야 한다 (동일 쿼리 관련성 가정 하)
    const redisIdx = hits.findIndex((x) => /redis/i.test(x.content));
    const mongoIdx = hits.findIndex((x) => /mongodb/i.test(x.content));
    r.check("ranking.importance_signal", redisIdx !== -1 && (mongoIdx === -1 || redisIdx < mongoIdx),
      `redis@${redisIdx} vs mongo@${mongoIdx} (importance 0.9 vs 0.1)`);

    // 강화: recall된 항목의 access_count가 올라가야 한다 (비동기 업데이트라 잠시 대기)
    await new Promise((res) => setTimeout(res, 400));
    const { rows } = await h.pool.query<{ access_count: number }>(
      `select max(access_count) as access_count from memory_items where org_id = $1`, [h.orgId]);
    r.check("ranking.reinforcement", (rows[0]!.access_count ?? 0) > 0, `max access_count=${rows[0]!.access_count}`);
  });

  // ---------- 2.5 스코프 격리 (다른 조직의 기억이 새지 않는가) ----------
  r.section("2.5 Scope isolation");
  await r.guard("scope", async () => {
    const { rows } = await h.pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Other', 'other-' || substr(md5(random()::text),1,8)) returning id`);
    const otherOrg = rows[0]!.id;
    await h.memory.ltm.remember({ orgId: otherOrg }, {
      kind: "fact", content: "SECRET: the other organization uses Oracle and DB2.", importance: 1.0,
    });
    const mine = await h.memory.ltm.recall(scope, "Oracle DB2 secret database", 10);
    r.check("scope.cross_org_isolation", !mine.some((x) => /SECRET/.test(x.content)),
      `${mine.length} hits, none from the other org`);
    await h.pool.query(`delete from organizations where id = $1`, [otherOrg]);
  });

  // ---------- 2.6 사실 추출 (실제 LLM) ----------
  r.section("2.6 Fact extraction (실제 LLM)");
  await r.guard("extract", async () => {
    const convo: ChatMessage[] = [
      { role: "user", content: "Always run the linter before committing — I got burned by that last week." },
      { role: "assistant", content: "Noted. I'll run the linter before every commit." },
      { role: "user", content: "Also, we settled on Fastify over Express for the API layer." },
      { role: "assistant", content: "Understood, Fastify it is." },
    ];
    const stored = await h.memory.extractAndStore(scope, randomUUID(), convo);
    r.check("extract.produced_facts", stored > 0, `${stored} facts stored`);

    const back = await h.memory.ltm.recall(scope, "linting and web framework choice", 8);
    const hasLint = back.some((x) => /lint/i.test(x.content));
    const hasFastify = back.some((x) => /fastify/i.test(x.content));
    r.check("extract.semantically_recallable", hasLint || hasFastify,
      `lint=${hasLint} fastify=${hasFastify}; recalled: ${back.map((x) => x.content.slice(0, 40)).join(" | ")}`);
  });

  // ---------- 2.7 Context Injection (buildContext → assemblePrompt) ----------
  r.section("2.7 Context Injection");
  await r.guard("context", async () => {
    const ctx = await h.memory.buildContext(scope, compactSession, "What database are we using?");
    r.check("context.has_facts", ctx.facts.length > 0, `${ctx.facts.length} LTM facts`);
    r.check("context.has_summary", !!ctx.stmSummary, `summary present=${!!ctx.stmSummary}`);
    r.check("context.has_history", ctx.history.length > 0, `${ctx.history.length} history messages`);

    const assembled = assemblePrompt({
      systemCore: "You are AIOS.",
      memoryFacts: ctx.facts,
      ragChunks: [],
      stmSummary: ctx.stmSummary,
      history: ctx.history,
      userMessage: "What database are we using?",
      budgetTokens: 8000,
    });
    r.check("context.injected_into_prompt",
      assembled.system.includes("Long-term memory") && ctx.facts.some((f) => assembled.system.includes(f.slice(0, 30))),
      `system prompt ${estimateTokens(assembled.system)} tokens, sections present`);
    // 상한만 보면 '아무것도 주입되지 않음'(0 토큰)이 통과한다.
    r.check("context.budget_respected", assembled.usedTokens > 0 && assembled.usedTokens <= 8000,
      `used=${assembled.usedTokens} of 8000 budget, dropped=${JSON.stringify(assembled.dropped)}`);

    // 예산이 아주 작을 때: 필수 섹션은 살아남고 나머지는 잘려야 한다
    const tight = assemblePrompt({
      systemCore: "You are AIOS.",
      memoryFacts: ctx.facts,
      ragChunks: ["x".repeat(8000)],
      stmSummary: ctx.stmSummary,
      history: ctx.history,
      userMessage: "hi",
      budgetTokens: 300,
    });
    r.check("context.degrades_gracefully",
      tight.system.includes("You are AIOS.") && tight.messages.at(-1)!.content === "hi" && tight.dropped.length > 0,
      `dropped=${JSON.stringify(tight.dropped)}`);
  });

  // ---------- 2.8 GDPR 삭제 + 망각 ----------
  r.section("2.8 Deletion & decay");
  await r.guard("forget", async () => {
    const { id } = await h.memory.ltm.remember(scope, { kind: "fact", content: "Temporary throwaway note about nothing.", importance: 0.05 });
    const ok = await h.memory.ltm.forget(id, h.orgId);
    r.check("forget.deletes", ok, `deleted=${ok}`);
    const notOk = await h.memory.ltm.forget(id, h.orgId);
    r.check("forget.idempotent", !notOk, `second delete returned ${notOk}`);

    // 다른 조직 id로는 삭제 불가해야 한다
    const { id: id2 } = await h.memory.ltm.remember(scope, { kind: "fact", content: "Protected note.", importance: 0.5 });
    const cross = await h.memory.ltm.forget(id2, "00000000-0000-0000-0000-000000000000");
    r.check("forget.tenant_guard", !cross, `cross-tenant delete returned ${cross}`);
  });
} finally {
  await h.close();
}

r.finish();
