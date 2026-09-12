import { z } from "zod";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { ToolDefinition } from "../registry.js";

/**
 * 공공통계 데이터 질의 도구 (DuckDB, 1.4억 행).
 *
 * ── 왜 SQL을 LLM에게 주는가 ────────────────────────────────────
 * 이 데이터는 6,568개 시계열 × 임의의 지역·항목·시점 조합이다. 미리 만들어둔
 * 엔드포인트 몇 개로는 질문의 다양성을 감당할 수 없다. SQL이 유일하게 충분한 표현력이다.
 *
 * ── 그래서 무엇을 막아야 하는가 ────────────────────────────────
 * 프롬프트 인젝션으로 다음이 시도된다고 가정한다:
 *   read_csv('/etc/passwd')  ·  COPY ... TO '/tmp/exfil'  ·  INSTALL httpfs (네트워크 유출)
 *   ATTACH '/다른/db'        ·  거대 카테시안 조인 (자원 고갈)
 *
 * 방어는 네 겹이다:
 *   1) DB 파일을 READ_ONLY로 연다 — 쓰기가 물리적으로 불가능하다.
 *   2) enable_external_access=false — 파일/네트워크 접근을 끈다.
 *      이것이 가능한 이유가 데이터를 Parquet이 아니라 DB 파일로 물질화한 이유다.
 *      Parquet을 직접 읽으면 read_parquet에 외부 접근이 필요해 이 방어를 쓸 수 없다.
 *   3) lock_configuration=true — 질의 안에서 SET으로 위 설정을 되돌리지 못하게 한다.
 *   4) SELECT/WITH 로 시작하는 단일 문장만 허용 + 강제 LIMIT + 타임아웃.
 *
 * 4번을 문자열 검사로만 하지 않는 이유: 문자열 필터는 우회당한다.
 * 1~3번이 실제 방어이고 4번은 실수 방지용이다. 이 순서를 뒤집으면 안 된다.
 */

const MAX_ROWS = 500;
const MAX_CELL_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 의미 검색 유사도 하한.
 *
 * 코사인 유사도는 질의가 아무리 무의미해도 항상 상위 k개를 돌려준다. 하한이 없으면
 * "asdfqwerzxcv"에 '성별 인구 및 성비'가 나오고, 모델은 그것을 답이라고 믿는다.
 * 조용히 틀린 답을 주는 것이 "못 찾았다"보다 나쁘다.
 *
 * 0.5는 실측으로 정했다 (bge-m3, 6,568개 통계표):
 *   의미 있는 질의: 실업률 0.723 · 전세 0.665 · 집값 0.622 · 인구 0.613 · 날씨 0.550
 *   무의미한 질의: 존재하지않는통계zzz 0.471 · 🍕피자먹고싶다 0.465 · asdfqwerzxcv 0.397
 * 두 구간 사이(0.471 ~ 0.550)의 중간이다. 임베딩 모델을 바꾸면 다시 재야 한다.
 */
const MIN_SIMILARITY = 0.5;

export interface BigDataOptions {
  /** 도구와 HTTP 라우트가 공유하는 DuckDB 접근 지점 */
  store: BigDataReader;
  /**
   * 질의어를 벡터로 만드는 함수. 있으면 카탈로그 의미 검색이 켜진다.
   * 없으면 부분 문자열 검색만 한다 — 임베딩 없이도 도구가 동작해야 하므로 선택값이다.
   */
  embed?: (texts: string[]) => Promise<number[][]>;
}

/** HTTP/도구는 질의 계약만 사용한다. 네이티브 연결이 API 프로세스로 새지 않게 한다. */
export interface BigDataReader {
  readonly timeoutMs: number;
  query<T = Record<string, unknown>>(sql: string, signal: AbortSignal): Promise<T[]>;
}

/**
 * DuckDB 접근 지점.
 *
 * 도구(LLM)와 HTTP 라우트(웹 UI)가 **같은 인스턴스를 공유해야 한다.**
 * DuckDB는 읽기 전용 연결도 파일 락을 잡으므로, 각자 따로 열면 두 번째가
 * "Conflicting lock is held" 로 실패한다.
 *
 * 인스턴스를 재사용하는 또 다른 이유: 매 호출마다 열면 1.4억 행 DB에서 2초 넘게 걸린다.
 * 지연 초기화라 DB가 없는 배포에서는 처음 쓸 때까지 아무 비용도 들지 않는다.
 */
export class BigDataStore {
  private instance: Promise<DuckDBInstance> | null = null;

  constructor(
    private dbPath: string,
    readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    /**
     * 분석 엔진이 이 프로세스에서 써도 되는 자원의 상한.
     *
     * **왜 명시해야 하는가:** DuckDB 의 기본값은 단독 실행을 전제한다 —
     * 실측한 기본값이 `max_memory 12.7GiB`, `threads 10`(전 코어)이었다.
     * 16GB 머신에서 질의 하나가 12.7GB 를 노리는 셈이고, 같은 프로세스가 HTTP 도 처리한다.
     * 실제로 전체 검증 중 스왑이 8GB 중 7GB 까지 차고 API 서버가
     * `EXC_BAD_ACCESS` 로 죽었다. 그 뒤 단계들이 전부 "fetch failed" 로 무너졌고,
     * 원인은 한참 뒤에야 드러났다.
     *
     * **실측으로 정한 값:** 우리 질의(카테고리 집계·팩트 대량 집계·전체 행 수·벡터 의미검색)는
     * `memory_limit=512MB` 에서 2GB 와 **같은 속도로** 전부 동작한다.
     * 기본 2GB 는 그 4배 여유이면서 DuckDB 기본값보다 6배 작다.
     * threads 4 도 마찬가지로 속도 차이가 없었다 — 남은 코어는 HTTP 가 쓴다.
     *
     * 사용자 질의 하나가 서버 전체를 죽일 수 있으면 안 된다.
     */
    private limits: { memory?: string; threads?: number } = {},
  ) {}

  private async open(): Promise<DuckDBInstance> {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    // 설정은 인스턴스 생성 시 한 번만 건다.
    // 연결마다 `set lock_configuration=true` 를 하면 **두 번째 연결이 실패한다** —
    // 잠금은 인스턴스 전역이라 이미 잠긴 값을 다시 SET 하는 것이 에러가 된다.
    // (실제로 그렇게 만들었다가 두 번째 도구 호출에서 터졌다.)
    return DuckDBInstance.create(this.dbPath, {
      access_mode: "READ_ONLY",
      enable_external_access: "false",
      memory_limit: this.limits.memory ?? "2GB",
      threads: String(this.limits.threads ?? 4),
      // lock_configuration 은 **맨 마지막에** 온다 — 잠근 뒤에는 위 값들도 바꿀 수 없다.
      lock_configuration: "true",
    });
  }

  /** 임의 SQL을 실행하고 행 객체를 돌려준다. 취소·타임아웃은 호출자가 signal로 준다. */
  async query<T = Record<string, unknown>>(sql: string, signal: AbortSignal): Promise<T[]> {
    signal.throwIfAborted();
    const con = await this.connect();
    const timer = setTimeout(() => con.interrupt(), this.timeoutMs);
    const onAbort = () => con.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await con.runAndReadAll(sql);
      return result.getRowObjects() as T[];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      con.closeSync();
    }
  }

  async connect(): Promise<DuckDBConnection> {
    this.instance ??= this.open();
    let inst: DuckDBInstance;
    try {
      inst = await this.instance;
    } catch (err) {
      // 실패한 Promise를 캐시에 남기면 이후 모든 호출이 같은 에러를 낸다.
      this.instance = null;
      throw err;
    }
    return inst.connect();
  }
}

/** BigInt·날짜 등 JSON으로 직렬화되지 않는 값을 사람이 읽을 문자열로 만든다. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, "");
  if (typeof v === "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  // 남은 타입은 string/boolean/symbol뿐이다. 객체는 위에서 처리했으므로
  // "[object Object]"가 새어 나올 수 없다.
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

/**
 * 결과를 TSV로 돌려준다. JSON이 아니라 TSV인 이유: 같은 내용에 토큰이 절반 이하로 든다.
 * 500행 × 8열이면 JSON은 키 이름을 4,000번 반복한다.
 */
function toTsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(결과 없음)";
  const cols = Object.keys(rows[0]!);
  const lines = [cols.join("\t")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join("\t"));
  return lines.join("\n");
}

/** 취소·타임아웃 처리는 store가 한다. 무거운 질의가 사용자가 떠난 뒤에도 CPU를 태우면 안 된다. */
function runQuery(
  store: BigDataReader,
  sql: string,
  signal: AbortSignal,
  _timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  return store.query(sql, signal);
}

const SCHEMA_DOC = `
테이블 두 개만 있다.

catalog (6,568행) — 어떤 통계표가 있는지
  series_id INT   facts와 조인하는 키
  category        예: '01_인구_사회', '10_건설_주택_토지'
  source          예: 'KOSIS', 'OWID'
  table_code, series_name, unit, period_type
  period_min, period_max, row_count, region_count, item_count

facts (140,332,002행) — 실제 관측치
  series_id INT, category
  value DOUBLE    숫자값 (원본이 비었으면 NULL)
  raw_value       원문 문자열
  region          지역명 (예: '서울특별시', '서울', '동구')
  region_code     출처가 부여한 코드. **출처 간 비교 불가** — 아래 경고 참조
  sido            원본이 제공한 시도. 채움률 23%로 낮다
  sido_norm       region에서 정규화한 시도 ('서울특별시'·'서울'·'서울 강동구' → 모두 '서울')
  cls1, cls2, cls3   분류 계층
  item            항목명
  period          시점 문자열 ('2024', '2024-03', '2024-03-01 12:00' 등 통계표마다 다름)
  period_value BIGINT

주의:
- 한글은 NFC로 저장돼 있다. 그냥 타이핑한 값으로 비교하면 된다.
- period 형식이 통계표마다 다르므로 범위 비교 전에 catalog.period_type을 확인하라.
- value가 NULL인 행이 약 3% 있다. 집계 시 대부분 자동 제외되지만 count(*)는 포함한다.

지역 다루기 — 틀리기 쉬운 곳이다:
- **region_code로 조인하지 마라.** KOSIS는 전 행이 'KOR'(국가 코드)이고, KMA는 관측소 번호,
  OWID는 ISO 국가코드다. 서로 다른 체계라 조인하면 조용히 틀린 결과가 나온다.
- **지역 필터는 sido_norm을 써라.** region='서울'로 거르면 '서울특별시' 97만 행을 놓친다.
- '동구'·'중구'·'고성군' 같은 시군구명은 여러 시도에 동시에 존재해 그 자체로는 식별되지 않는다.
  이런 이름을 필터에 쓸 때는 결과가 여러 지역을 합친 것일 수 있다고 사용자에게 알려라.
- 해양관측(KMA)의 region은 대부분 섬·해역 이름(덕적도·거문도)이라 sido_norm이 NULL이다.
  예외로 '울산'·'인천' 부이는 그 도시 앞바다에 있어 sido_norm이 붙는다 — 오류가 아니다.
`.trim();

export function createBigDataTools(opts: BigDataOptions): ToolDefinition[] {
  const pool = opts.store;
  const timeoutMs = opts.store.timeoutMs;

  /**
   * catalog_embeddings 테이블이 있는지 한 번만 확인한다.
   * build.py embed 를 돌리지 않은 배포에서도 도구가 동작해야 하므로,
   * 없으면 조용히 부분 문자열 검색으로 내려간다.
   */
  let semanticReady: Promise<boolean> | null = null;
  const hasEmbeddings = async (signal: AbortSignal): Promise<boolean> => {
    semanticReady ??= runQuery(
      pool,
      "select count(*) n from duckdb_tables() where table_name = 'catalog_embeddings'",
      signal,
      timeoutMs,
    )
      .then((r) => Number(r[0]?.n ?? 0) > 0)
      .catch(() => false);
    return semanticReady;
  };

  const searchTool: ToolDefinition = {
    name: "bigdata_search",
    description:
      "한국 공공통계 카탈로그에서 통계표를 검색한다. 데이터를 조회하기 전에 " +
      "먼저 이 도구로 어떤 통계표가 있는지 찾아 series_id를 얻어라. " +
      "키워드는 통계표 이름에 대해 부분 일치로 검색한다.",
    permission: "read",
    schema: z.object({
      keyword: z.string().min(1).max(100).describe("검색어 (예: '전세가격', '인구', '실업률')"),
      category: z.string().max(50).optional().describe("카테고리로 좁히기 (예: '10_건설_주택_토지')"),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    async handler(ctx, args) {
      // 사용자 입력을 SQL에 문자열로 넣지 않는다 — 파라미터 바인딩이 없는 경로라
      // 작은따옴표를 이스케이프한다(이 값은 LIKE 패턴으로만 쓰인다).
      const kw = args.keyword.replace(/'/g, "''");
      const cat = args.category?.replace(/'/g, "''");
      const sql = `
        select series_id, category, source, series_name, unit, period_type,
               period_min, period_max, row_count, region_count, item_count
        from catalog
        where series_name ilike '%${kw}%'
          ${cat ? `and category = '${cat}'` : ""}
        order by row_count desc
        limit ${args.limit}`;
      let rows = await runQuery(pool, sql, ctx.signal, timeoutMs);

      // 부분 문자열로 못 찾으면 의미 검색으로 재시도한다.
      // 사용자는 통계청이 붙인 정확한 명칭을 모르는 것이 정상이다 —
      // "집값"으로 "전세가격지수"를 찾을 수 있어야 한다.
      if (rows.length === 0 && opts.embed && (await hasEmbeddings(ctx.signal))) {
        const [vec] = await opts.embed([args.keyword]);
        if (vec) {
          const literal = `[${vec.map((x) => x.toFixed(6)).join(",")}]::FLOAT[${vec.length}]`;
          rows = await runQuery(
            pool,
            `select c.series_id, c.category, c.source, c.series_name, c.unit, c.period_type,
                    c.period_min, c.period_max, c.row_count,
                    round(array_cosine_similarity(e.embedding, ${literal})::DOUBLE, 3) as similarity
               from catalog c join catalog_embeddings e using (series_id)
               ${cat ? `where c.category = '${cat}'` : ""}
              order by similarity desc
              limit ${args.limit}`,
            ctx.signal,
            timeoutMs,
          );
          // 하한 미만은 버린다. 남는 게 없으면 아래 '못 찾았다' 경로로 떨어진다.
          rows = rows.filter((row) => Number(row.similarity ?? 0) >= MIN_SIMILARITY);
          if (rows.length > 0) {
            return `(이름에 '${args.keyword}'가 없어 의미가 가까운 통계표를 찾았다)\n${toTsv(rows)}`;
          }
        }
      }

      if (rows.length === 0) {
        // 빈 결과에 힌트를 붙인다. LLM이 같은 검색을 반복하는 것을 막는다.
        const cats = await runQuery(
          pool,
          "select category, count(*) n from catalog group by 1 order by n desc",
          ctx.signal,
          timeoutMs,
        );
        return (
          `'${args.keyword}' 로 찾은 통계표가 없다. 이름으로도, 의미로도 가까운 것이 없다.\n` +
          `다른 표현으로 다시 검색하거나 아래 카테고리를 참고하라.\n\n${toTsv(cats)}`
        );
      }
      return toTsv(rows);
    },
  };

  const queryTool: ToolDefinition = {
    name: "bigdata_query",
    description:
      "한국 공공통계 데이터베이스에 읽기 전용 SQL(DuckDB 문법)을 실행한다.\n" +
      `최대 ${MAX_ROWS}행까지 반환하므로 집계해서 물어라.\n\n${SCHEMA_DOC}`,
    permission: "read",
    schema: z.object({
      sql: z.string().min(1).max(4000).describe("SELECT 또는 WITH 로 시작하는 단일 SQL 문"),
    }),
    async handler(ctx, args) {
      const sql = args.sql.trim().replace(/;\s*$/, "");
      // 실수 방지용 검사다. 진짜 방어는 READ_ONLY + external_access=false 이다.
      if (!/^(select|with)\b/i.test(sql)) {
        return "거부: SELECT 또는 WITH 로 시작하는 문장만 실행할 수 있다.";
      }
      if (sql.includes(";")) {
        return "거부: 여러 문장을 한 번에 실행할 수 없다. 세미콜론을 제거하라.";
      }
      // LIMIT이 없으면 붙인다. 없이 실행하면 수천만 행을 직렬화하다 메모리를 태운다.
      const limited = /\blimit\s+\d+/i.test(sql) ? sql : `${sql}\nlimit ${MAX_ROWS}`;
      let rows: Record<string, unknown>[];
      try {
        rows = await runQuery(pool, limited, ctx.signal, timeoutMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 에러를 그대로 돌려준다. LLM이 스스로 SQL을 고칠 수 있어야 왕복이 줄어든다.
        return `SQL 오류: ${msg.slice(0, 400)}`;
      }
      const body = toTsv(rows);
      return rows.length >= MAX_ROWS
        ? `${body}\n\n(${MAX_ROWS}행에서 잘림 — 더 집계하거나 조건을 좁혀라)`
        : body;
    },
  };

  /**
   * 시계열 조회 전용 도구.
   *
   * queryTool이 있는데 왜 또 만드는가: 가장 흔한 질문이 "이 통계표의 시간에 따른 변화"인데,
   * 그걸 물을 때마다 모델이 조인과 GROUP BY를 정확히 써야 한다면 실패율이 높다.
   * 실제로 7B 로컬 모델이 `catalog.period_type = '년월'` 이라고 추측해(실제값은 '월')
   * 0행을 받았다. 존재하지 않는 값으로 필터링해도 SQL은 성공하므로 오류로 드러나지도 않는다.
   * 흔한 질문 하나를 파라미터 3개로 줄이면 그 실패 경로 자체가 사라진다.
   */
  const seriesTool: ToolDefinition = {
    name: "bigdata_series",
    description:
      "특정 통계표(series_id)의 시계열을 조회한다. bigdata_search 로 series_id를 먼저 찾아라. " +
      "SQL을 쓰지 않고 시간에 따른 값 변화를 볼 때 이 도구를 써라.",
    permission: "read",
    schema: z.object({
      series_id: z.number().int().describe("bigdata_search 가 알려준 series_id"),
      period_prefix: z.string().max(20).optional()
        .describe("시점 접두사로 거르기 (예: '2024' → 2024년, '2024-03' → 2024년 3월)"),
      region: z.string().max(50).optional().describe("지역명으로 거르기 (예: '서울')"),
      item: z.string().max(100).optional().describe("항목명으로 거르기"),
      limit: z.number().int().min(1).max(200).default(30),
      order: z.enum(["desc", "asc"]).default("desc").describe("desc = 최근부터"),
    }),
    async handler(ctx, args) {
      const esc = (v: string) => v.replace(/'/g, "''");
      const where = [`f.series_id = ${args.series_id}`];
      if (args.period_prefix) where.push(`f.period like '${esc(args.period_prefix)}%'`);
      if (args.region) where.push(`f.region = '${esc(args.region)}'`);
      if (args.item) where.push(`f.item like '%${esc(args.item)}%'`);

      const meta = await runQuery(
        pool,
        `select series_name, unit, period_type, period_min, period_max, region_count, item_count
           from catalog where series_id = ${args.series_id}`,
        ctx.signal,
        timeoutMs,
      );
      if (meta.length === 0) return `series_id ${args.series_id} 인 통계표가 없다. bigdata_search 로 먼저 찾아라.`;

      const rows = await runQuery(
        pool,
        `select f.period, count(*) n, round(avg(f.value), 3) avg_value,
                round(min(f.value), 3) min_value, round(max(f.value), 3) max_value
           from facts f
          where ${where.join(" and ")} and f.value is not null
          group by f.period
          order by f.period ${args.order === "asc" ? "asc" : "desc"}
          limit ${args.limit}`,
        ctx.signal,
        timeoutMs,
      );
      const head = toTsv(meta);
      if (rows.length === 0) {
        // 왜 비었는지 알려준다. 그냥 "결과 없음"이면 모델이 같은 실수를 반복한다.
        const sample = await runQuery(
          pool,
          `select distinct f.period from facts f where f.series_id = ${args.series_id}
            order by f.period desc limit 8`,
          ctx.signal,
          timeoutMs,
        );
        return `${head}\n\n조건에 맞는 데이터가 없다.\n실제 존재하는 시점 예시:\n${toTsv(sample)}`;
      }
      return `${head}\n\n${toTsv(rows)}`;
    },
  };

  return [searchTool, seriesTool, queryTool];
}
