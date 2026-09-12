import { Pool } from "pg";
import { Redis } from "ioredis";
import { AiosError, loadEnv, type Env } from "@aios/shared";
import { AiRouter, AnthropicAdapter, GeminiAdapter, LocalAdapter, MODEL_CATALOG, OpenAiAdapter, XaiAdapter, localModels, type ProviderAdapter } from "@aios/ai";
import { LongTermMemory, MemoryEngine, ShortTermMemory } from "@aios/memory";
import { CodeRetriever, Indexer } from "@aios/indexer";
import { DEFAULT_POLICY, ToolExecutor, ToolRegistry, createBigDataTools, createRunCommandTool, listDirTool, readFileTool, writeFileTool } from "@aios/tools";
import { BigDataProcess } from "./bigdata-process.js";
import type { ChatMessage, ProviderId } from "@aios/shared";
import { EventBus } from "./bus.js";
import { UsageMeter } from "./billing/usage.js";

/**
 * 애플리케이션 컨텍스트 — 조립 루트(composition root).
 * DI 컨테이너를 쓰지 않는 이유: 의존 그래프가 한눈에 보이는 명시적 조립이
 * 이 규모에서는 컨테이너의 마법보다 디버깅·리뷰에 압도적으로 유리하다.
 */
export interface AppContext {
  env: Env;
  pool: Pool;
  redis: Redis;
  router: AiRouter;
  memory: MemoryEngine;
  retriever: CodeRetriever;
  indexer: Indexer;
  tools: ToolRegistry;
  executor: ToolExecutor;
  bus: EventBus;
  usage: UsageMeter;
  /** 공공통계 데이터셋. BIGDATA_DB_PATH 미설정이면 null — 라우트가 아예 등록되지 않는다. */
  bigdata: BigDataProcess | null;
  close(): Promise<void>;
}

export async function createContext(): Promise<AppContext> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  // 부팅 시점에 의존성 도달 가능성을 확인한다.
  // 첫 사용자 요청에서 발견하면 그 요청은 이미 실패한 뒤다 — 실패는 배포 단계에서 나야
  // 롤백 판단이 가능하고, 헬스체크가 파드를 트래픽에서 빼 준다.
  await Promise.all([
    pool.query("select 1").catch((err: Error) => {
      throw new AiosError("db_unreachable", `cannot reach Postgres at boot: ${err.message}`, { status: 503, cause: err });
    }),
    redis.ping().catch((err: Error) => {
      throw new AiosError("redis_unreachable", `cannot reach Redis at boot: ${err.message}`, { status: 503, cause: err });
    }),
  ]);

  // --- AI Router: 키가 있는 프로바이더만 조립 ---
  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
  if (env.OPENAI_API_KEY) adapters.openai = new OpenAiAdapter(env.OPENAI_API_KEY);
  if (env.ANTHROPIC_API_KEY) adapters.anthropic = new AnthropicAdapter(env.ANTHROPIC_API_KEY);
  if (env.GEMINI_API_KEY) adapters.gemini = new GeminiAdapter(env.GEMINI_API_KEY);
  if (env.XAI_API_KEY) adapters.xai = new XaiAdapter(env.XAI_API_KEY);
  // 로컬 추론 서버. 이것만 있어도 외부 키 없이 제품 전체가 동작한다.
  if (env.LOCAL_LLM_BASE_URL) {
    adapters.local = new LocalAdapter(
      env.LOCAL_LLM_BASE_URL, env.LOCAL_EMBED_MODEL, undefined,
      env.LOCAL_EMBED_CONCURRENCY, env.LOCAL_CHAT_CONCURRENCY,
      env.LOCAL_LLM_PROTOCOL, env.LOCAL_LLM_CONTEXT,
    );
  }

  // 로컬 모델은 사용자의 머신 상태이므로 코드 상수가 아니라 설정에서 카탈로그로 합친다.
  const catalog = env.LOCAL_LLM_BASE_URL
    ? [...MODEL_CATALOG, ...localModels(env.LOCAL_LLM_MODELS.split(","), env.LOCAL_LLM_CONTEXT)]
    : MODEL_CATALOG;

  // 프로바이더 키가 하나도 없으면 부팅을 거부한다.
  // 그냥 뜨게 두면 파드는 healthy로 보이면서 모든 채팅 요청이 500을 낸다 — 배포 파이프라인이
  // "성공"으로 판단해 구버전을 내려버리는 최악의 시나리오가 된다.
  // 크래시루프로 실패하면 롤아웃이 멈추고 기존 파드가 계속 서비스한다.
  if (Object.keys(adapters).length === 0) {
    await Promise.allSettled([pool.end(), redis.quit()]);
    throw new AiosError(
      "no_providers_configured",
      "no LLM provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
        "GEMINI_API_KEY, XAI_API_KEY, or LOCAL_LLM_BASE_URL (e.g. http://127.0.0.1:11434/v1 " +
        "for Ollama — no API key required). Refusing to start so the rollout halts instead of " +
        "serving requests that would fail.",
      { status: 500 },
    );
  }

  const usage = new UsageMeter(pool, redis);
  const router = new AiRouter(adapters, {
    catalog,
    onUsage: ({ model, usage: u }) => usage.recordDeferred({ provider: model.provider, model: model.id, usage: u }),
  });

  const embed = (texts: string[]) => router.embed(texts);

  // --- Memory: 요약/사실추출은 라우터의 저가 모델로 (의존성 주입) ---
  const stm = new ShortTermMemory(redis);
  // 요약 예산을 프롬프트에 명시한다. STM이 최후에 잘라내긴 하지만, 잘린 요약은 문장이
  // 끊겨 품질이 떨어진다 — 모델이 처음부터 예산 안에서 쓰게 하는 편이 낫다.
  const summaryBudget = stm.summaryTokenBudget;
  const summarize = async (existing: string | null, messages: ChatMessage[]): Promise<string> => {
    let out = "";
    for await (const ev of router.stream(
      {
        system:
          `Merge the running summary with the new messages into at most ${summaryBudget} tokens. ` +
          "Keep decisions, constraints, and open questions; drop pleasantries and restated context. " +
          "Output only the merged summary.",
        messages: [
          {
            role: "user",
            content: `Running summary:\n${existing ?? "(none)"}\n\nNew messages:\n${messages
              .map((m) => `${m.role}: ${m.content}`)
              .join("\n")}`,
          },
        ],
        maxTokens: Math.max(512, summaryBudget * 2),
      },
      { taskClass: "summarize" },
    )) {
      if (ev.type === "text_delta") out += ev.text;
    }
    return out.trim();
  };

  const extractFacts = async (messages: ChatMessage[]) => {
    let out = "";
    const { EXTRACT_FACTS_PROMPT, parseExtractedFacts } = await import("@aios/memory");
    for await (const ev of router.stream(
      {
        system: EXTRACT_FACTS_PROMPT,
        messages: [{ role: "user", content: messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 20_000) }],
        maxTokens: 1000,
      },
      { taskClass: "cheap" },
    )) {
      if (ev.type === "text_delta") out += ev.text;
    }
    // 파싱과 검증은 memory 패키지가 한다 — 여기서 따로 하면 하네스 쪽 구현과 갈라진다.
    return parseExtractedFacts(out);
  };

  const memory = new MemoryEngine(stm, new LongTermMemory(pool, embed, { dedupeThreshold: env.MEMORY_DEDUPE_THRESHOLD }), { summarize, extractFacts });

  // --- Tools ---
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(createRunCommandTool({ image: env.SANDBOX_IMAGE, workspaceReadOnly: true }));
  // 공공통계 도구는 DB 파일이 설정된 배포에만 노출한다.
  // 도구와 HTTP 라우트가 같은 DuckDB 인스턴스를 공유한다.
  // 각자 열면 읽기 전용이어도 파일 락이 충돌한다.
  const bigdata = env.BIGDATA_DB_PATH
    ? new BigDataProcess(env.BIGDATA_DB_PATH, undefined,
        { memory: env.BIGDATA_MEMORY_LIMIT, threads: env.BIGDATA_THREADS })
    : null;
  if (bigdata) {
    // embed를 넘겨 카탈로그 의미 검색을 켠다. 라우터가 로컬/외부 임베더를 알아서 고른다.
    for (const t of createBigDataTools({ store: bigdata, embed })) tools.register(t);
  }
  // 등록된 도구를 부팅 로그에 남긴다. 도구가 조용히 빠지면
  // "모델이 도구를 안 쓴다"로 보여 원인을 엉뚱한 곳에서 찾게 된다 — 실제로 그랬다.
  // 여기는 Fastify 로거가 아직 없는 부팅 경로라 console을 쓴다.
  // eslint-disable-next-line no-console
  console.log(`[tools] ${tools.list().map((t) => t.name).join(", ")}`);

  // 무인증 모드는 조용히 켜지면 안 된다. 부팅 로그에서 반드시 눈에 띄어야 한다.
  if (env.LOCAL_NO_AUTH) {
    // eslint-disable-next-line no-console
    console.warn(
      `[auth] LOCAL_NO_AUTH 활성 — 루프백(127.0.0.1) 요청은 키 없이 owner 권한으로 통과한다. ` +
        `조직 slug='${env.LOCAL_NO_AUTH_ORG_SLUG}'. 외부에 노출된 포트에서는 켜지 말 것.`,
    );
  }

  // 승인 콜백이 없는 모든 경로는 실패 폐쇄한다. 로컬 모드도 예외가 아니다.
  const policy = { ...DEFAULT_POLICY, modes: { read: "auto", write: "confirm", exec: "confirm", net: "deny" } as const };
  const executor = new ToolExecutor(tools, policy, async (r) => {
    await pool.query(
      `insert into tool_invocations (session_id, tool_name, arguments, result, status, sandboxed, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [r.sessionId, r.toolName, JSON.stringify(r.args), JSON.stringify({ preview: r.resultPreview }), r.status, r.sandboxed, r.durationMs],
    );
  });

  const retriever = new CodeRetriever(pool, embed);
  const indexer = new Indexer(pool, embed);
  const bus = new EventBus(redis);

  return {
    env, pool, redis, router, memory, retriever, indexer, tools, executor, bus, usage, bigdata,
    async close() {
      await closeAllResources([() => bigdata?.close(), () => pool.end(), () => redis.quit()]);
    },
  };
}
import { closeAllResources } from "./shutdown.js";
