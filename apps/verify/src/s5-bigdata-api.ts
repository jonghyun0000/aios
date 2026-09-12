/**
 * Sprint #5 — 공공통계 HTTP API 검증 (웹 UI가 쓰는 경로).
 *
 * s4-bigdata 와 나눈 이유는 DuckDB 파일 락이다.
 * DuckDB는 읽기 전용 연결도 파일 락을 잡으므로, s4처럼 직접 DB를 열면 서버가 떠 있을 때 실패한다.
 * 이 스크립트는 HTTP만 쓰므로 **서버가 떠 있어야** 돌아간다. 두 검증은 배타적이다.
 */
import { Report } from "./report.js";

const BASE = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8790";
const KEY = process.env.AIOS_API_KEY;
const r = new Report("Sprint#5 — 공공통계 HTTP API");

if (!KEY) {
  r.check("AIOS_API_KEY 환경변수", false, "API 키 없이는 라우트를 호출할 수 없다");
  r.finish();
}

async function api<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY!}` } });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

interface SeriesRow {
  series_id: number; series_name: string; category: string; row_count: number;
  region_count: number; region_code_count: number; item_count: number;
  period_min: string; period_max: string; unit: string | null;
}

r.section("A. 카테고리");

let firstCategory = "";
await r.guard("카테고리 목록", async () => {
  const { status, body } = await api<{ categories: { category: string; series_count: number; row_count: number }[] }>(
    "/v1/bigdata/categories",
  );
  r.check("200", status === 200, `status=${status}`);
  const cats = body.categories ?? [];
  firstCategory = cats[0]?.category ?? "";
  r.check("카테고리 19개 이상", cats.length >= 19, `${cats.length}개`);
  const totalRows = cats.reduce((s, c) => s + Number(c.row_count), 0);
  // 행수를 하드코딩하지 않는다. 데이터가 늘 때마다 검증이 깨지고,
  // 그러면 "데이터가 늘었다"와 "적재가 깨졌다"를 구분할 수 없게 된다.
  r.check("합계가 1억 행 이상", totalRows > 100_000_000, totalRows.toLocaleString());
  // BigInt가 JSON으로 새면 숫자가 문자열로 오거나 직렬화가 터진다.
  r.check("숫자로 직렬화됨", typeof cats[0]?.row_count === "number", typeof cats[0]?.row_count);
});

r.section("B. 카탈로그 검색");

let sampleId = 0;
await r.guard("키워드 검색", async () => {
  const { status, body } = await api<{ series: SeriesRow[]; total: number }>(
    "/v1/bigdata/catalog?q=" + encodeURIComponent("전세가격") + "&limit=5",
  );
  r.check("200", status === 200, `status=${status}`);
  r.check("결과 있음", body.series.length > 0, `${body.total}건 중 ${body.series.length}개`);
  r.check("전부 키워드 포함", body.series.every((s) => s.series_name.includes("전세가격")),
    body.series[0]?.series_name ?? "");
  sampleId = body.series[0]?.series_id ?? 0;
});

await r.guard("카테고리 필터", async () => {
  const { body } = await api<{ series: SeriesRow[]; total: number }>(
    `/v1/bigdata/catalog?category=${encodeURIComponent(firstCategory)}&limit=5`,
  );
  r.check("전부 해당 카테고리", body.series.every((s) => s.category === firstCategory),
    `${firstCategory} / ${body.total}건`);
  // NFC 왕복이 깨지면 여기서 0건이 된다 (에러 없이).
  r.check("한글 카테고리가 매칭된다", body.total > 0, `${body.total}건`);
});

await r.guard("페이지네이션이 겹치지 않는다", async () => {
  const p1 = await api<{ series: SeriesRow[] }>("/v1/bigdata/catalog?limit=10&offset=0");
  const p2 = await api<{ series: SeriesRow[] }>("/v1/bigdata/catalog?limit=10&offset=10");
  const ids1 = new Set(p1.body.series.map((s) => s.series_id));
  const overlap = p2.body.series.filter((s) => ids1.has(s.series_id));
  r.check("1·2페이지 중복 없음", overlap.length === 0, `중복 ${overlap.length}건`);
});

await r.guard("없는 키워드는 빈 결과", async () => {
  const { status, body } = await api<{ series: SeriesRow[]; total: number }>(
    "/v1/bigdata/catalog?q=" + encodeURIComponent("존재하지않는통계zzz"),
  );
  // HTTP 라우트는 의미검색을 하지 않는다(도구와 역할이 다르다). 빈 결과가 정상이다.
  r.check("200 + 0건", status === 200 && body.total === 0, `status=${status} total=${body.total}`);
});

r.section("C. 시계열 상세");

await r.guard("메타·시계열·패싯을 함께 반환", async () => {
  const { status, body } = await api<{
    series: SeriesRow; points: { period: string; avg_value: number | null; n: number }[];
    regions: { region: string; n: number }[]; items: { item: string; n: number }[];
  }>(`/v1/bigdata/series/${sampleId}`);
  r.check("200", status === 200, `status=${status}`);
  r.check("시계열 포인트 있음", body.points.length > 0, `${body.points.length}개 시점`);
  r.check("시점이 오름차순", body.points.every((p, i) => i === 0 || p.period >= body.points[i - 1]!.period),
    `${body.points[0]?.period} → ${body.points.at(-1)?.period}`);

  // 화면이 "지역 N개"라고 말하면서 M개만 고르게 하면 사용자를 속이는 것이다.
  // 실제로 카탈로그가 region_code(전부 'KOR')를 세어 1이 나왔고 드롭다운은 50개였다.
  r.check("region_count가 실제 목록과 일치",
    body.series.region_count === body.regions.length,
    `catalog=${body.series.region_count} 목록=${body.regions.length}`);
  r.check("item_count가 실제 목록과 일치",
    body.series.item_count === body.items.length,
    `catalog=${body.series.item_count} 목록=${body.items.length}`);
  r.check("region_code_count는 별도 필드", typeof body.series.region_code_count === "number",
    `region_code_count=${body.series.region_code_count}`);
});

await r.guard("지역 필터가 결과를 바꾼다", async () => {
  const all = await api<{ points: { avg_value: number | null }[]; regions: { region: string }[] }>(
    `/v1/bigdata/series/${sampleId}`,
  );
  const region = all.body.regions[1]?.region;
  if (!region) throw new Error("필터할 지역이 없다");
  const one = await api<{ points: { avg_value: number | null }[] }>(
    `/v1/bigdata/series/${sampleId}?region=${encodeURIComponent(region)}`,
  );
  const same = JSON.stringify(all.body.points) === JSON.stringify(one.body.points);
  // 필터가 무시되면 화면은 필터를 적용했다고 표시하면서 같은 값을 보여준다 — 조용한 거짓말이다.
  r.check(`'${region}' 필터가 반영됨`, !same, same ? "필터 전후 동일!" : "값이 달라짐");
});

await r.guard("잘림을 숨기지 않는다", async () => {
  // 조용히 자르면 차트가 전체 기간인 척한다. 10분 간격 해양관측에서 실제로 그랬다.
  const { body } = await api<{ points: unknown[]; truncated: boolean; limit: number }>(
    `/v1/bigdata/series/${sampleId}?limit=5`,
  );
  // limit 이하가 아니라 정확히 limit 이어야 한다. 0개도 '이하'라서 통과했다.
  r.check("limit 만큼만 반환", body.points.length === 5, `${body.points.length}개`);
  r.check("truncated 플래그", body.truncated === true, `truncated=${body.truncated}`);
  const full = await api<{ truncated: boolean }>(`/v1/bigdata/series/${sampleId}?limit=2000`);
  r.check("잘리지 않으면 false", full.body.truncated === false, `truncated=${full.body.truncated}`);
});

await r.guard("시점 필터", async () => {
  const { body } = await api<{ points: { period: string }[] }>(
    `/v1/bigdata/series/${sampleId}?period_prefix=2024`,
  );
  r.check("전부 2024로 시작", body.points.every((p) => p.period.startsWith("2024")),
    `${body.points.length}개 시점`);
});

await r.guard("없는 series_id는 404", async () => {
  const { status } = await api(`/v1/bigdata/series/9999999`);
  r.check("404", status === 404, `status=${status}`);
});

r.section("D. CSV 내보내기");

await r.guard("CSV 헤더·본문·BOM", async () => {
  const res = await fetch(`${BASE}/v1/bigdata/series/${sampleId}/export?limit=5`, {
    headers: { authorization: `Bearer ${KEY!}` },
  });
  r.check("200", res.status === 200, `status=${res.status}`);
  r.check("content-type=csv", res.headers.get("content-type")?.includes("text/csv") === true,
    res.headers.get("content-type") ?? "");
  r.check("파일명 지정", res.headers.get("content-disposition")?.includes(`series-${sampleId}.csv`) === true,
    res.headers.get("content-disposition") ?? "");

  // BOM은 바이트로 확인해야 한다. res.text()는 규격상 BOM을 제거하므로
  // 문자열로 보면 항상 '없음'으로 보인다 — 실제로 그렇게 오판했다.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  r.check("UTF-8 BOM (Excel 한글 깨짐 방지)", hasBom,
    `첫 3바이트 = ${[...bytes.slice(0, 3)].map((b) => b.toString(16)).join(" ")}`);

  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  r.check("헤더 컬럼 10개", lines[0]?.split(",").length === 10, lines[0]?.slice(0, 70) ?? "");
  r.check("데이터 행 존재", lines.length > 1, `${lines.length - 1}행`);
});

r.section("E. 인증");

await r.guard("인증 없이는 접근 불가", async () => {
  for (const path of ["/v1/bigdata/categories", "/v1/bigdata/catalog", `/v1/bigdata/series/${sampleId}`]) {
    const res = await fetch(`${BASE}${path}`);
    r.check(`401: ${path}`, res.status === 401, `status=${res.status}`);
  }
});

r.section("F. 자원 보호");

await r.guard("catalog limit 상한", async () => {
  const { status, body } = await api<{ series: SeriesRow[] }>("/v1/bigdata/catalog?limit=99999");
  // zod가 거부해야 한다. 통과하면 한 번에 6,568행을 직렬화하게 된다.
  r.check("과도한 limit 거부", status === 400, `status=${status} 반환 ${body.series?.length ?? "-"}건`);
});

await r.guard("응답 시간", async () => {
  const t0 = Date.now();
  await api(`/v1/bigdata/series/${sampleId}`);
  const ms = Date.now() - t0;
  // 1.4억 행에서 한 시리즈를 뽑는 것이 느리면 UI가 못 쓰게 된다.
  r.check("상세 조회 < 3000ms", ms < 3000, `${ms}ms`);
});

r.finish();
