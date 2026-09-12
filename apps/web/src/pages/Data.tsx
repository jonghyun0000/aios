import { useState } from "react";
import { get, apiKeyStore } from "../lib/api.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { LineChart, type Point } from "../components/LineChart.js";
import { Link } from "../lib/router.js";

interface CategoryRow { category: string; series_count: number; row_count: number }
interface SeriesRow {
  series_id: number; category: string; source: string; table_code: string;
  series_name: string; unit: string | null; period_type: string | null;
  period_min: string | null; period_max: string | null;
  row_count: number; region_count: number; region_code_count: number;
  item_count: number; null_count: number;
}
interface CatalogResponse { series: SeriesRow[]; total: number; limit: number; offset: number }
interface SeriesDetail {
  series: SeriesRow & { rel_path: string };
  points: Point[];
  regions: { region: string; n: number }[];
  items: { item: string; n: number }[];
  truncated: boolean;
  limit: number;
}

const PAGE = 30;

export function DataPage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<"rows" | "name" | "recent">("rows");

  const cats = useAsync(() => get<{ categories: CategoryRow[] }>("/v1/bigdata/categories"), []);
  const list = useAsync(
    () =>
      get<CatalogResponse>(
        `/v1/bigdata/catalog?limit=${PAGE}&offset=${offset}&sort=${sort}` +
          (query ? `&q=${encodeURIComponent(query)}` : "") +
          (category ? `&category=${encodeURIComponent(category)}` : ""),
      ),
    [query, category, offset, sort],
  );

  const apply = (next: { q?: string; cat?: string; sort?: typeof sort }) => {
    if (next.q !== undefined) setQuery(next.q);
    if (next.cat !== undefined) setCategory(next.cat);
    if (next.sort !== undefined) setSort(next.sort);
    setOffset(0); // 조건이 바뀌면 첫 페이지로. 안 그러면 빈 페이지가 보인다.
  };

  const total = list.data?.total ?? 0;

  return (
    <div className="main-narrow" style={{ maxWidth: 1100 }}>
      <h1>공공통계</h1>
      <p className="page-sub">
        {cats.data
          ? `${cats.data.categories.reduce((s, c) => s + c.series_count, 0).toLocaleString()}개 통계표 · ` +
            `${cats.data.categories.reduce((s, c) => s + c.row_count, 0).toLocaleString()}행`
          : "불러오는 중…"}
      </p>

      <form
        className="row wrap"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => { e.preventDefault(); apply({ q: input.trim() }); }}
      >
        {/* placeholder는 라벨이 아니다 — 입력을 시작하면 사라지고,
            스크린리더가 안정적으로 읽어주지 않는다. aria-label로 이름을 준다. */}
        <input
          aria-label="통계표 이름 검색"
          placeholder="통계표 이름으로 검색 (예: 전세가격, 인구, 실업률)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <select aria-label="분야 필터" value={category} onChange={(e) => apply({ cat: e.target.value })} style={{ width: 190 }}>
          <option value="">전체 분야</option>
          {cats.data?.categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.series_count})
            </option>
          ))}
        </select>
        <select aria-label="정렬 기준" value={sort} onChange={(e) => apply({ sort: e.target.value as typeof sort })} style={{ width: 130 }}>
          <option value="rows">데이터 많은순</option>
          <option value="recent">최신순</option>
          <option value="name">이름순</option>
        </select>
        <button type="submit">검색</button>
        {(query || category) && (
          <button type="button" onClick={() => { setInput(""); apply({ q: "", cat: "" }); }}>초기화</button>
        )}
      </form>

      <AsyncBoundary loading={list.loading} error={list.error} empty={total === 0}>
        <div className="row-between small muted" style={{ marginBottom: 8 }}>
          {/* 검색·페이지 이동 결과가 낭독되지 않으면 조작이 반영됐는지 알 수 없다 */}
          <span role="status" aria-live="polite">
            {total.toLocaleString()}개 중 {offset + 1}–{Math.min(offset + PAGE, total)}
          </span>
          <span className="row">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>이전</button>
            <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>다음</button>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>통계표</th><th>분야</th><th>주기</th><th>기간</th><th style={{ textAlign: "right" }}>행수</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.series.map((s) => (
              <tr key={s.series_id}>
                <td>
                  <Link to={`/data/${s.series_id}`}>{s.series_name}</Link>
                  {s.unit && <div className="small muted">{s.unit}</div>}
                </td>
                <td className="small">{s.category}</td>
                <td className="small">{s.period_type ?? "-"}</td>
                <td className="small mono">{s.period_min}~{s.period_max}</td>
                <td className="small mono" style={{ textAlign: "right" }}>{s.row_count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AsyncBoundary>

      {!list.loading && total === 0 && (
        <p className="small muted">
          이름에 일치하는 통계표가 없습니다. 다른 표현으로 검색하거나
          <button type="button" style={{ padding: "2px 8px", margin: "0 4px" }}
                  onClick={() => { setInput(""); apply({ q: "", cat: "" }); }}>전체 보기</button>
          를 눌러보세요. 채팅에서 물으면 의미가 비슷한 통계도 찾아줍니다.
        </p>
      )}
      <p className="small muted" style={{ marginTop: 16 }}>
        찾는 통계가 없나요? <Link to="/chat">채팅</Link>에서 자연어로 물으면 AI가 의미 기반으로 찾아줍니다.
      </p>
    </div>
  );
}

export function DataDetailPage({ seriesId }: { seriesId: string }) {
  const [periodPrefix, setPeriodPrefix] = useState("");
  const [region, setRegion] = useState("");
  const [item, setItem] = useState("");

  const detail = useAsync(
    () =>
      get<SeriesDetail>(
        `/v1/bigdata/series/${encodeURIComponent(seriesId)}?` +
          new URLSearchParams({
            ...(periodPrefix ? { period_prefix: periodPrefix } : {}),
            ...(region ? { region } : {}),
            ...(item ? { item } : {}),
          }).toString(),
      ),
    [seriesId, periodPrefix, region, item],
  );

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /**
   * CSV는 fetch로 받아 Blob으로 저장한다.
   *
   * `<a href>`가 더 간단하지만 API 키 인증에서는 토큰을 쿼리에 실어야 하고,
   * 그러면 키가 브라우저 히스토리·리퍼러·서버 액세스 로그에 남는다.
   * 비밀을 URL에 넣지 않는다는 원칙이 링크 하나 아끼는 것보다 중요하다.
   * (쿠키 세션이면 <a>로도 되지만, 두 경로를 나누면 한쪽만 썩는다.)
   */
  const downloadCsv = async () => {
    setDownloading(true);
    setDownloadError(null);
    const params = new URLSearchParams({
      ...(periodPrefix ? { period_prefix: periodPrefix } : {}),
      ...(region ? { region } : {}),
    });
    const key = apiKeyStore.get();
    try {
      const res = await fetch(
        `/v1/bigdata/series/${encodeURIComponent(seriesId)}/export?${params.toString()}`,
        { credentials: "include", headers: key ? { authorization: `Bearer ${key}` } : {} },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `series-${seriesId}.csv`;
      a.click();
      // objectURL을 해제하지 않으면 탭이 살아 있는 동안 blob이 메모리에 남는다.
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const s = detail.data?.series;

  return (
    <div className="main-narrow" style={{ maxWidth: 1000 }}>
      <p className="small"><Link to="/data">← 공공통계</Link></p>
      {/*
        제목을 AsyncBoundary 밖에 둔다.
        안에 두면 로딩 중에는 페이지에 h1 이 아예 없어, 스크린리더 사용자가
        자기가 어느 페이지에 있는지 알 수 없다("불러오는 중"만 들린다).
        통계표 이름을 알기 전에는 일반명으로 두고, 오면 바꾼다.
      */}
      <h1>{s ? s.series_name : "통계표"}</h1>
      <AsyncBoundary loading={detail.loading} error={detail.error}>
        {s && detail.data && (
          <>
            <p className="page-sub small">
              {s.source} · {s.category} · <code>{s.table_code}</code>
            </p>

            <div className="grid grid-3" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="small muted">단위</div>
                <strong>{s.unit || "-"}</strong>
              </div>
              <div className="card">
                <div className="small muted">기간 ({s.period_type})</div>
                <strong className="mono small">{s.period_min} ~ {s.period_max}</strong>
              </div>
              <div className="card">
                <div className="small muted">데이터</div>
                <strong>{s.row_count.toLocaleString()}행</strong>
                <div className="small muted">
                  지역 {s.region_count.toLocaleString()} · 항목 {s.item_count.toLocaleString()}
                  {s.null_count > 0 && ` · 결측 ${Math.round((100 * s.null_count) / s.row_count)}%`}
                </div>
              </div>
            </div>

            <div className="row wrap" style={{ marginBottom: 12 }}>
              <input
                aria-label="시점 필터"
                placeholder="시점 필터 (예: 2024)"
                value={periodPrefix}
                onChange={(e) => setPeriodPrefix(e.target.value)}
                style={{ width: 170 }}
              />
              {detail.data.regions.length > 1 && (
                <select aria-label="지역 필터" value={region} onChange={(e) => setRegion(e.target.value)} style={{ width: 190 }}>
                  <option value="">전체 지역 ({detail.data.regions.length})</option>
                  {detail.data.regions.map((r) => (
                    <option key={r.region} value={r.region}>{r.region} ({r.n.toLocaleString()})</option>
                  ))}
                </select>
              )}
              {detail.data.items.length > 1 && (
                <select aria-label="항목 필터" value={item} onChange={(e) => setItem(e.target.value)} style={{ width: 220 }}>
                  <option value="">전체 항목 ({detail.data.items.length})</option>
                  {detail.data.items.map((i) => (
                    <option key={i.item} value={i.item}>{i.item}</option>
                  ))}
                </select>
              )}
              <button onClick={() => void downloadCsv()} disabled={downloading}>
                {downloading ? "내려받는 중…" : "CSV 내려받기"}
              </button>
            </div>

            {downloadError && <div className="alert" role="alert">CSV 내려받기 실패: {downloadError}</div>}

            <div className="card">
              <LineChart points={detail.data.points} unit={s.unit} />
              <div className="small muted" style={{ marginTop: 8 }}>
                {detail.data.points.length.toLocaleString()}개 시점
                {(region || item || periodPrefix) && " (필터 적용됨)"}
                {" · 같은 시점에 여러 관측이 있으면 평균을 표시합니다."}
              </div>
              {detail.data.truncated && (
                <div className="alert" role="status" style={{ marginTop: 8, marginBottom: 0 }}>
                  앞 {detail.data.limit.toLocaleString()}개 시점만 표시했습니다.
                  차트가 전체 기간을 보여주지 않습니다 — 시점 필터를 좁히거나 CSV로 내려받으세요.
                </div>
              )}
            </div>

            <h2>최근 값</h2>
            <table>
              <thead>
                <tr><th>시점</th><th style={{ textAlign: "right" }}>평균</th>
                    <th style={{ textAlign: "right" }}>최소</th><th style={{ textAlign: "right" }}>최대</th>
                    <th style={{ textAlign: "right" }}>관측수</th></tr>
              </thead>
              <tbody>
                {[...detail.data.points].reverse().slice(0, 12).map((p) => (
                  <tr key={p.period}>
                    <td className="mono small">{p.period}</td>
                    <td className="mono small" style={{ textAlign: "right" }}>
                      {p.avg_value === null ? "-" : p.avg_value.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                    </td>
                    <td className="mono small muted" style={{ textAlign: "right" }}>
                      {p.min_value?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? "-"}
                    </td>
                    <td className="mono small muted" style={{ textAlign: "right" }}>
                      {p.max_value?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? "-"}
                    </td>
                    <td className="mono small muted" style={{ textAlign: "right" }}>{p.n?.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">출처 파일: <code>{s.rel_path}</code></p>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}
