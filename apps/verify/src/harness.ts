/**
 * 검증 하네스 공용 부트스트랩 — 실제 Postgres/Redis/프로바이더에 연결한다.
 * 프로덕션 조립 루트(apps/api/src/context.ts)와 같은 방식으로 조립하되,
 * 검증에 필요한 것만 만든다. 이렇게 하면 하네스가 통과했는데 서버는 실패하는
 * "테스트 전용 배선" 문제를 피할 수 있다.
 */
import { Pool } from "pg";
import { Redis } from "ioredis";
import { AiRouter, AnthropicAdapter, GeminiAdapter, LocalAdapter, MODEL_CATALOG, OpenAiAdapter, XaiAdapter, localModels } from "@aios/ai";
import type { ProviderAdapter } from "@aios/ai";
import { LongTermMemory, MemoryEngine, ShortTermMemory, EXTRACT_FACTS_PROMPT, parseExtractedFacts } from "@aios/memory";
import type { ChatMessage, ProviderId } from "@aios/shared";

type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface Harness {
  pool: Pool;
  redis: Redis;
  router: AiRouter;
  memory: MemoryEngine;
  /** 하네스가 실제로 고른 임베더. 성능 계측이 임베딩 구간을 분리해 재려면 필요하다. */
  embed: EmbedFn;
  /**
   * DB pgvector 컬럼의 실제 차원.
   * 자체 임베더를 만드는 검증 단계(hashEmbedder)가 이걸 쓰지 않으면
   * `expected 1024 dimensions, not 1536` 으로 insert 단계에서야 터진다.
   */
  embedDim: number | null;
  orgId: string;
  userId: string;
  close(): Promise<void>;
}

/**
 * 임베딩 폴백.
 * Anthropic은 임베딩 API를 제공하지 않는다. OpenAI/Gemini 키가 없는 환경에서도
 * 메모리/RAG 파이프라인의 '구조'를 검증할 수 있어야 하므로, 결정론적 해시 임베딩을 쓴다.
 * 의미 검색 품질은 이것으로 검증할 수 없다 — 그 부분은 키가 있을 때만 검증되며,
 * 하네스가 어떤 임베더를 썼는지 항상 출력해 결과 해석을 오도하지 않게 한다.
 */
/**
 * 차원 기본값을 1536(OpenAI)으로 못 박아 두면 안 된다.
 * DB가 bge-m3(1024)로 마이그레이션된 환경에서 하네스만 1536을 만들어
 * insert 단계에서 터진다 — 그것도 "메모리 파이프라인 실패"처럼 보이는 형태로.
 * 그래서 EMBED_DIM 을 따르고, createHarness 는 DB 실제 컬럼과 대조한다.
 */
export function hashEmbedder(dim = Number(process.env.EMBED_DIM) || 1536) {
  return async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      // 단어 단위 해시 → 차원에 분산. 같은 단어를 공유하면 코사인 유사도가 올라간다.
      for (const word of t.toLowerCase().split(/\W+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) {
          h ^= word.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        v[Math.abs(h) % dim]! += 1;
        v[Math.abs(h >> 8) % dim]! += 0.5;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
}

/** pgvector 컬럼의 실제 차원. 없으면 null. */
async function embeddingDim(pool: Pool): Promise<number | null> {
  const { rows } = await pool.query<{ dim: number | null }>(
    `select atttypmod as dim
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_type t on t.oid = a.atttypid
      where t.typname = 'vector' and c.relname = 'memory_items' and a.attname = 'embedding'`,
  );
  const dim = rows[0]?.dim;
  return typeof dim === "number" && dim > 0 ? dim : null;
}

export async function createHarness(): Promise<Harness> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
  if (process.env.OPENAI_API_KEY) adapters.openai = new OpenAiAdapter(process.env.OPENAI_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) adapters.anthropic = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY);
  if (process.env.GEMINI_API_KEY) adapters.gemini = new GeminiAdapter(process.env.GEMINI_API_KEY);
  if (process.env.XAI_API_KEY) adapters.xai = new XaiAdapter(process.env.XAI_API_KEY);
  /*
   * 로컬 추론 서버. 프로덕션 조립부(apps/api/src/context.ts)가 이걸 등록하는데
   * 하네스만 빠뜨리고 있었다. 그래서 외부 키 없이 도는 오프라인 구성에서
   * 제품은 정상인데 검증만 `no_providers` 로 죽었다 —
   * "하네스는 통과했는데 서버는 실패한다"의 정확한 반대 형태다.
   * 조립부가 아는 프로바이더는 하네스도 알아야 한다.
   */
  if (process.env.LOCAL_LLM_BASE_URL) {
    adapters.local = new LocalAdapter(process.env.LOCAL_LLM_BASE_URL, process.env.LOCAL_EMBED_MODEL, undefined, Number(process.env.LOCAL_EMBED_CONCURRENCY) || undefined, Number(process.env.LOCAL_CHAT_CONCURRENCY) || undefined);
  }
  /*
   * 로컬 모델은 사용자의 머신 상태라 MODEL_CATALOG(코드 상수)에 없다.
   * 합쳐 주지 않으면 어댑터는 있는데 후보 모델이 0개가 되어
   * 라우터가 그대로 `no_providers` 로 죽는다.
   */
  const catalog = process.env.LOCAL_LLM_BASE_URL
    ? [
        ...MODEL_CATALOG,
        ...localModels(
          (process.env.LOCAL_LLM_MODELS ?? "qwen3:8b").split(","),
          Number(process.env.LOCAL_LLM_CONTEXT) || 32768,
        ),
      ]
    : MODEL_CATALOG;
  const router = new AiRouter(adapters, { catalog });

  // DB가 진실이다. 선언된 EMBED_DIM 이 아니라 실제 컬럼 차원을 읽는다.
  const dbDim = await embeddingDim(pool);

  const hasRealEmbedder = Boolean(
    process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
  );
  const embed = hasRealEmbedder ? (t: string[]) => router.embed(t) : hashEmbedder(dbDim ?? undefined);

  if (hasRealEmbedder && dbDim) {
    // 차원이 어긋나면 insert 단계에서야 터지고, 그때는 원인이 임베더라는 게 드러나지 않는다.
    // 여기서 한 번 재서 즉시 실패시킨다.
    const [probe] = await embed(["차원 확인"]);
    if (probe && probe.length !== dbDim) {
      throw new Error(
        `임베딩 차원 불일치: 임베더 ${probe.length} vs DB 컬럼 ${dbDim}. ` +
          `EMBED_DIM=${probe.length} node scripts/set-embedding-dim.mjs 로 스키마를 맞춰라.`,
      );
    }
  }
  console.log(
    `  (embedder: ${hasRealEmbedder ? (adapters.local ? "local" : "provider") : "deterministic-hash fallback"}` +
      `, dim: ${dbDim ?? "unknown"})`,
  );

  const summarize = async (existing: string | null, messages: ChatMessage[]): Promise<string> => {
    let out = "";
    for await (const ev of router.stream(
      {
        system:
          "Merge the running summary with the new messages into <=200 tokens. Keep decisions, constraints, and open questions. Output only the merged summary.",
        messages: [
          {
            role: "user",
            content: `Running summary:\n${existing ?? "(none)"}\n\nNew messages:\n${messages
              .map((m) => `${m.role}: ${m.content}`)
              .join("\n")}`,
          },
        ],
        maxTokens: 400,
      },
      { taskClass: "summarize" },
    )) {
      if (ev.type === "text_delta") out += ev.text;
    }
    return out.trim();
  };

  const extractFacts = async (messages: ChatMessage[]) => {
    let out = "";
    for await (const ev of router.stream(
      {
        system: EXTRACT_FACTS_PROMPT,
        messages: [
          { role: "user", content: messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 20_000) },
        ],
        maxTokens: 1000,
      },
      { taskClass: "cheap" },
    )) {
      if (ev.type === "text_delta") out += ev.text;
    }
    // 프로덕션 조립부와 같은 함수를 쓴다 — 하네스만 다르게 검증하면
    // "하네스는 통과했는데 서버는 실패한다"가 된다.
    return parseExtractedFacts(out);
  };

  const memory = new MemoryEngine(
    // 압축 경로를 실제로 밟기 위해 예산을 작게 잡는다(프로덕션 기본값은 8000).
    new ShortTermMemory(redis, { maxTokens: Number(process.env.VERIFY_STM_BUDGET ?? 500) }),
    new LongTermMemory(pool, embed, { dedupeThreshold: Number(process.env.MEMORY_DEDUPE_THRESHOLD) || undefined }),
    { summarize, extractFacts },
  );

  // 검증 전용 조직/사용자 — 매 실행마다 새로 만들어 이전 실행과 격리
  const { rows: orgRows } = await pool.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Verify Org', 'verify-' || substr(md5(random()::text), 1, 8)) returning id`,
  );
  const orgId = orgRows[0]!.id;
  const { rows: userRows } = await pool.query<{ id: string }>(
    `insert into users (id, email) values (gen_random_uuid(), 'verify-' || substr(md5(random()::text),1,8) || '@aios.local') returning id`,
  );
  const userId = userRows[0]!.id;
  await pool.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, userId]);

  return {
    pool, redis, router, memory, embed, embedDim: dbDim, orgId, userId,
    async close() {
      // 검증 데이터 정리 (cascade로 memory_items/sessions 등 동반 삭제)
      await pool.query(`delete from organizations where id = $1`, [orgId]).catch(() => {});
      await pool.query(`delete from users where id = $1`, [userId]).catch(() => {});
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}
