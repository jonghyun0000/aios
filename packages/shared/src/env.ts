import { z } from "zod";

/**
 * 환경변수는 부팅 시 1회 파싱·검증한다.
 * 이유: process.env를 코드 곳곳에서 읽으면 오타·누락이 런타임 한가운데서 터진다.
 * 잘못된 설정은 부팅 실패로 즉사시키는 것이 프로덕션에서 가장 싸게 먹힌다.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  LOCAL_WORKSPACE_ROOT: z.string().optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),

  // --- 로컬 추론 서버 (Ollama / llama.cpp / LM Studio / vLLM) ---
  // 이 값이 있으면 외부 API 키가 하나도 없어도 제품이 정상 기동한다.
  LOCAL_LLM_BASE_URL: z.string().url().optional(),
  LOCAL_LLM_PROTOCOL: z.enum(["openai", "ollama"]).default("openai"),
  // 카탈로그에 등록할 모델 id. 쉼표 구분. 로컬 모델은 사용자가 무엇을 받았는지
  // 서버가 알 수 없으므로 코드가 아니라 설정으로 받는다.
  // 기본값을 qwen3:8b 로 둔 근거는 실측이다 (tools/bigdata/model_bench.py):
  //   qwen3:8b     도구 100% / 인자 100% / 한국어 100% / 지시 100%
  //   qwen2.5:7b   도구 100% / 인자 100% / 한국어  62% / 지시 100%
  //   llama3.1:8b  도구  88% / 인자  75% / 한국어  88% / 지시 100%
  // qwen2.5는 한국어 답변에 중국어가 섞이는 일이 3번에 1번꼴로 있었다.
  LOCAL_LLM_MODELS: z.string().default("qwen3:8b"),
  LOCAL_EMBED_MODEL: z.string().default("bge-m3"),
  /**
   * 로컬 임베딩 서버에 동시에 던질 최대 요청 수.
   * 기본 4는 bge-m3/MacBook Air 실측값이다 — 근거는 packages/ai/src/providers/local.ts.
   * 처리량은 4 근처에서 포화하고, 더 올리면 지연만 나빠진다(4→25 에서 p95 5~7배).
   * GPU 서버라면 슬롯이 더 많으므로 올릴 값이 있다.
   */
  LOCAL_EMBED_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * 로컬 서버에 동시에 던질 최대 **생성** 요청 수.
   * 기본 2는 실측 근거다 — 초과하면 요청이 서버 큐에서 대기하다가 undici 헤더 타임아웃(300초)에
   * 걸려 네트워크 오류로 죽는다(실측: 동시성 6에서 12개 중 2개 사망, TTFT p50 343초).
   * 근거는 packages/ai/src/providers/local.ts. GPU 슬롯이 많으면 올린다.
   */
  LOCAL_CHAT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  /**
   * 장기기억 중복 판정 임계값. 임베더마다 유사도 분포가 달라 코드 상수로 둘 수 없다.
   * 기본 0.97 은 bge-m3 실측으로 고른 값이다 — 근거는 packages/memory/src/long-term.ts.
   * 내리면 서로 다른 사실이 병합돼 조용히 사라진다. 올리면 중복이 쌓일 뿐이다.
   */
  MEMORY_DEDUPE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.97),
  // 로컬 모델의 컨텍스트 창. 모델마다 달라 라우터가 추정할 수 없다.
  LOCAL_LLM_CONTEXT: z.coerce.number().int().min(2048).default(32768),

  // --- 공공통계 데이터셋 (DuckDB) ---
  // 설정하면 bigdata_search / bigdata_query 도구가 등록된다.
  // 없으면 도구가 아예 노출되지 않는다 — 데이터가 없는 배포에서 LLM이
  // 존재하지 않는 도구를 부르며 실패하는 것을 막는다.
  BIGDATA_DB_PATH: z.string().optional(),
  /**
   * 분석 엔진(DuckDB)이 이 프로세스에서 써도 되는 상한.
   * 기본값을 명시하는 이유는 DuckDB 기본이 단독 실행 전제라 RAM 의 대부분(실측 12.7GiB)과
   * 전 코어를 잡기 때문이다 — 같은 프로세스가 HTTP 도 처리하는데.
   * 실측상 우리 질의는 512MB/4스레드로 충분하다. 근거는 packages/tools/src/builtin/bigdata.ts.
   */
  BIGDATA_MEMORY_LIMIT: z.string().default("2GB"),
  BIGDATA_THREADS: z.coerce.number().int().min(1).max(64).default(4),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_BASE: z.string().url().default("https://api.stripe.com"),
  // Checkout 성공/취소 후 사용자를 돌려보낼 곳. Stripe가 이 URL로 리다이렉트한다.
  BILLING_SUCCESS_URL: z.string().url().optional(),
  BILLING_CANCEL_URL: z.string().url().optional(),

  // 마켓플레이스 심사 권한을 가진 조직. 미설정이면 아무도 승인할 수 없다(= 서명된 것만 유통).
  MARKETPLACE_REVIEWER_ORG: z.string().uuid().optional(),

  // --- OAuth (자체 authorization code flow) ---
  // Supabase를 쓰지 않는 배포에서도 로그인이 가능해야 한다.
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  // 로그인 후 돌아갈 수 있는 프론트엔드 오리진 화이트리스트 (쉼표 구분).
  // open redirect를 막으려면 반드시 서버가 허용 목록을 가져야 한다.
  OAUTH_ALLOWED_REDIRECTS: z.string().default(""),

  SANDBOX_IMAGE: z.string().default("aios-sandbox:latest"),

  // --- 로컬 무인증 모드 ---
  // 켜면 루프백(127.0.0.1 / ::1)에서 온 /v1/* 요청이 키 없이 owner 권한으로 통과한다.
  // 왜 필요한가: 키 없이 로컬 LLM + 내 데이터만으로 쓰는 구성에서, 정작 UI에 들어가려면
  // API 키를 발급받아 붙여넣어야 했다. 1인 로컬 사용에서 그 절차는 보호하는 것이 없다.
  // coerce.boolean을 쓰지 않는 이유: 빈 문자열이 아닌 모든 값이 true가 되어
  // LOCAL_NO_AUTH=0 이 "켜짐"으로 읽힌다. 명시적으로 파싱한다.
  LOCAL_NO_AUTH: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  // 무인증 요청이 사용할 조직 slug. 없으면 부팅 시 만든다.
  LOCAL_NO_AUTH_ORG_SLUG: z.string().min(1).default("local"),
}).superRefine((env, ctx) => {
  // 프로덕션에서 켜져 있으면 부팅을 거부한다. 이 플래그가 켜진 채 공개 포트에 뜨면
  // 조직 데이터 전체가 무인증으로 열린다 — 경고 로그로는 부족하고 즉사시켜야 한다.
  if (env.LOCAL_NO_AUTH && env.NODE_ENV === "production") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LOCAL_NO_AUTH"],
      message: "LOCAL_NO_AUTH must not be enabled when NODE_ENV=production",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
