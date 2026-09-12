/**
 * Sprint #4 — 공공통계 데이터 계층 검증.
 *
 * 왜 필요한가: bigdata 도구는 AI에게 1.4억 행에 대한 SQL 실행 권한을 준다.
 * 격리가 뚫리면 임의 파일 읽기·유출·네트워크 접근이 가능해진다.
 * 그런데 여기까지의 확인은 전부 일회성 수동 테스트였다 —
 * 실제로 `lock_configuration`이 두 번째 연결을 죽이는 버그를 '두 번 호출해 봤기 때문에'
 * 운으로 잡았다. 그런 것은 자동화되어야 한다.
 *
 * LLM을 거치지 않고 도구를 직접 호출한다. 모델의 도구 선택은 비결정적이라
 * 검증에 넣으면 제품 결함과 모델 변덕을 구분할 수 없게 된다.
 */
import { BigDataStore, createBigDataTools } from "@aios/tools";
import { Report } from "./report.js";

const DB = process.env.BIGDATA_DB_PATH ?? "/Volumes/T7/bigdata/bigdata.duckdb";
// 제목에 행수를 박지 않는다. 데이터가 늘면 제목이 조용히 거짓말이 된다.
const r = new Report("Sprint#4 — 공공통계 데이터 계층 (DuckDB)");

/** 라우터 없이 임베딩을 흉내 내지 않는다 — 실제 Ollama를 쓰되 없으면 해당 검사만 건너뛴다. */
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL ?? "bge-m3";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

const tools = createBigDataTools({ store: new BigDataStore(DB), embed });
const byName = new Map(tools.map((t) => [t.name, t]));

function ctx() {
  return {
    orgId: "verify-org",
    sessionId: "verify-session",
    projectRoot: "/tmp",
    signal: AbortSignal.timeout(60_000),
  };
}

async function call(name: string, args: unknown): Promise<string> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`도구 '${name}' 이 등록되지 않았다`);
  // 스키마 검증을 건너뛰지 않는다. 프로덕션 경로가 하는 일을 그대로 한다.
  const parsed = tool.schema.parse(args);
  const result = await tool.handler(ctx(), parsed);
  return typeof result === "string" ? result : result.output;
}

// ---------------------------------------------------------------- A. 등록
r.section("A. 도구 등록");
r.check("도구 3개 등록", tools.length === 3, tools.map((t) => t.name).join(", "));
r.check("전부 read 권한", tools.every((t) => t.permission === "read"),
  tools.map((t) => `${t.name}:${t.permission}`).join(" "));
r.check("샌드박스 불필요 표기", tools.every((t) => !t.requiresSandbox),
  "DB 접근은 프로세스 내 격리로 충분하다");

// ---------------------------------------------------------------- B. 격리
r.section("B. 격리 — 프롬프트 인젝션이 시도할 것들");

/** 차단되어야 하는 SQL. 결과가 정상 반환되면 뚫린 것이다. */
const ATTACKS: [string, string][] = [
  ["임의 파일 읽기", "select * from read_csv('/etc/passwd')"],
  ["홈 디렉터리 열람", "select * from glob('/Users/*')"],
  ["파일 쓰기(유출)", "copy (select 1) to '/tmp/aios-exfil.csv'"],
  ["확장 설치(네트워크)", "install httpfs"],
  ["다른 DB attach", "attach '/tmp/other.db' as o"],
  ["격리 설정 되돌리기", "set enable_external_access=true"],
  ["테이블 생성", "create table hack(x int)"],
  ["데이터 삭제", "delete from facts"],
  ["데이터 변조", "update facts set value = 0"],
  ["parquet 직접 읽기", "select * from read_parquet('/Volumes/T7/bigdata/parquet/catalog.parquet')"],
];

for (const [label, sql] of ATTACKS) {
  await r.guard(`차단: ${label}`, async () => {
    const out = await call("bigdata_query", { sql });
    // 도구는 예외를 던지지 않고 "SQL 오류: ..." 문자열로 돌려준다(모델이 스스로 고치도록).
    // 그러므로 '거부/오류' 문자열이 왔는지로 판정한다.
    const blocked = /^(SQL 오류|거부)/.test(out);
    r.check(`차단: ${label}`, blocked, blocked ? out.slice(0, 90) : `뚫림! → ${out.slice(0, 120)}`);
  });
}

await r.guard("여러 문장 실행 거부", async () => {
  const out = await call("bigdata_query", { sql: "select 1; drop table facts" });
  r.check("세미콜론 거부", out.startsWith("거부"), out.slice(0, 80));
});

await r.guard("SELECT 아닌 문장 거부", async () => {
  const out = await call("bigdata_query", { sql: "pragma database_list" });
  r.check("비-SELECT 거부", out.startsWith("거부"), out.slice(0, 80));
});

// ---------------------------------------------------------------- C. 연결 재사용
r.section("C. 연결 재사용 (lock_configuration 회귀 방지)");

await r.guard("연속 호출이 전부 성공한다", async () => {
  // 설정 잠금을 연결마다 걸면 두 번째부터 실패한다. 실제로 그렇게 만들었다가 터졌다.
  const results: string[] = [];
  for (let i = 0; i < 4; i++) {
    results.push(await call("bigdata_query", { sql: `select ${i} as n` }));
  }
  const ok = results.every((x, i) => x.includes(String(i)));
  r.check("4회 연속 호출 성공", ok, results.map((x) => x.split("\n")[1] ?? "?").join(" / "));
});

// ---------------------------------------------------------------- D. 데이터 정합성
r.section("D. 데이터 정합성");

await r.guard("팩트 행수", async () => {
  const out = await call("bigdata_query", { sql: "select count(*) n from facts" });
  const n = Number(out.split("\n")[1]);
  r.check("1억 행 이상", n > 100_000_000, `${n.toLocaleString()}행`);
});

await r.guard("카탈로그와 팩트의 시리즈가 일치", async () => {
  const out = await call("bigdata_query", {
    sql: `select (select count(distinct series_id) from facts) f,
                 (select count(*) from catalog) c,
                 (select count(*) from facts f2 left join catalog c2 using(series_id)
                   where c2.series_id is null) orphan`,
  });
  const [f, c, orphan] = out.split("\n")[1]!.split("\t").map(Number);
  r.check("고아 팩트 없음", orphan === 0, `orphan=${orphan}`);
  r.check("시리즈 수 일치", f === c, `facts=${f} catalog=${c}`);
});

await r.guard("한글 조건이 NFC로 동작한다", async () => {
  // 파일명 유래 문자열이 NFD로 저장되면 사람이 타이핑한 조건이 **에러 없이 0행**을 낸다.
  // 실제로 그랬다. 카테고리별로 전부 확인한다.
  const cats = await call("bigdata_query", {
    sql: "select category, count(*) n from facts group by 1 order by 1",
  });
  const lines = cats.split("\n").slice(1).filter(Boolean);
  let mismatched = 0;
  for (const line of lines) {
    const [cat, n] = line.split("\t");
    if (!cat) continue;
    // 조회로 얻은 값을 그대로 조건에 넣었을 때 같은 수가 나와야 한다.
    const one = await call("bigdata_query", {
      sql: `select count(*) n from facts where category = '${cat.replace(/'/g, "''")}'`,
    });
    if (one.split("\n")[1] !== n) mismatched++;
  }
  r.check(`카테고리 ${lines.length}개 전부 조건 일치`, mismatched === 0, `불일치 ${mismatched}개`);
  // 리터럴을 직접 타이핑한 경우(NFC)도 확인한다 — 위 검사는 왕복이라 NFD여도 통과한다.
  const typed = await call("bigdata_query", {
    sql: "select count(*) n from facts where category = '01_인구_사회'",
  });
  r.check("타이핑한 NFC 리터럴이 매칭된다", Number(typed.split("\n")[1]) > 0,
    `${Number(typed.split("\n")[1] ?? 0).toLocaleString()}행`);
});

// ---------------------------------------------------------------- E. 검색
r.section("E. bigdata_search");

await r.guard("정확한 키워드로 찾는다", async () => {
  const out = await call("bigdata_search", { keyword: "전세가격", limit: 5 });
  r.check("결과 있음", out.includes("series_id"), out.split("\n")[1]?.slice(0, 80) ?? "");
  r.check("전세가격 통계표 포함", out.includes("전세가격"), "");
});

await r.guard("무의미한 질의는 결과를 내지 않는다", async () => {
  // 코사인 유사도는 하한이 없으면 무엇을 물어도 상위 k개를 돌려준다.
  // 모델은 그것을 답이라고 믿으므로, 조용히 틀린 답이 "못 찾았다"보다 나쁘다.
  for (const junk of ["존재하지않는통계zzz", "asdfqwerzxcv"]) {
    const out = await call("bigdata_search", { keyword: junk, limit: 5 });
    const leaked = out.includes("의미가 가까운");
    r.check(`무의미 질의 '${junk}' 차단`, !leaked,
      leaked ? `유사 결과가 새어나옴: ${out.split("\n")[1]?.slice(0, 70)}` : "결과 없음 안내");
    r.check(`'${junk}' 안내 포함`, out.includes("카테고리"), "");
  }
});

await r.guard("약한 의미 매칭은 여전히 통과한다", async () => {
  // 하한을 너무 높이면 정상 질의까지 막힌다. '날씨'(0.550)가 경계에 가장 가깝다.
  const out = await call("bigdata_search", { keyword: "날씨", limit: 3 });
  r.check("'날씨' → 기상 관련 통계", /기후|기상|기온|강수/.test(out), out.split("\n")[1]?.slice(0, 80) ?? "");
});

// ---------------------------------------------------------------- F. 시계열
r.section("F. bigdata_series");

await r.guard("시계열을 반환한다", async () => {
  const search = await call("bigdata_search", { keyword: "전세가격지수", limit: 1 });
  const sid = Number(search.split("\n")[1]?.split("\t")[0]);
  r.check("series_id 확보", Number.isInteger(sid), `series_id=${sid}`);
  const out = await call("bigdata_series", { series_id: sid, limit: 5 });
  r.check("메타 + 데이터 반환", out.includes("series_name") && out.includes("avg_value"),
    out.split("\n").slice(0, 2).join(" | ").slice(0, 110));
});

await r.guard("없는 series_id는 안내를 준다", async () => {
  const out = await call("bigdata_series", { series_id: 999_999, limit: 5 });
  r.check("bigdata_search 로 유도", out.includes("bigdata_search"), out.slice(0, 90));
});

await r.guard("조건이 안 맞으면 실제 시점 예시를 준다", async () => {
  const search = await call("bigdata_search", { keyword: "전세가격지수", limit: 1 });
  const sid = Number(search.split("\n")[1]?.split("\t")[0]);
  const out = await call("bigdata_series", { series_id: sid, period_prefix: "1800", limit: 5 });
  // 7B 모델이 존재하지 않는 값으로 필터링해 0행을 받고 헤매던 문제를 막는 장치다.
  r.check("실제 시점 예시 포함", out.includes("실제 존재하는 시점"), out.slice(-120));
});

// ---------------------------------------------------------------- G. 의미 검색
r.section("G. 카탈로그 의미 검색");

await r.guard("구어체로도 관련 통계를 찾는다", async () => {
  // '집값'은 어느 통계표명에도 없다. 부분일치는 반드시 실패하고 의미검색으로 넘어가야 한다.
  const exact = await call("bigdata_query", {
    sql: "select count(*) n from catalog where series_name ilike '%집값%'",
  });
  r.check("'집값'은 이름에 존재하지 않음", Number(exact.split("\n")[1]) === 0, `${exact.split("\n")[1]}건`);

  const out = await call("bigdata_search", { keyword: "집값", limit: 5 });
  r.check("의미검색으로 전환됨", out.includes("의미가 가까운"), out.split("\n")[0]?.slice(0, 70) ?? "");
  r.check("주택 관련 통계를 찾음", /주택|전세|매매|아파트/.test(out), out.split("\n")[2]?.slice(0, 80) ?? "");
});

// ---------------------------------------------------------------- H. 자원 보호
r.section("H. 자원 보호");

await r.guard("LIMIT 없는 질의에 자동 상한이 걸린다", async () => {
  const out = await call("bigdata_query", { sql: "select series_id, period, value from facts" });
  const lines = out.split("\n").filter(Boolean);
  // 헤더 1줄 + 최대 500행 + 잘림 안내
  // 상한만 보면 0행(질의 실패로 빈 결과)도 통과한다 — 상한이 실제로 걸렸는지 보려면
  // 상한 근처까지 실제로 채워져야 한다.
  r.check("500행 이하로 제한", lines.length > 100 && lines.length <= 503, `${lines.length}줄`);
  r.check("잘림을 알린다", out.includes("잘림"), out.slice(-60));
});

await r.guard("SQL 오류는 모델이 고칠 수 있게 원문을 돌려준다", async () => {
  const out = await call("bigdata_query", { sql: "select nonexistent_column from facts" });
  r.check("오류 원문 포함", out.startsWith("SQL 오류") && out.length > 20, out.slice(0, 110));
});

r.finish();
