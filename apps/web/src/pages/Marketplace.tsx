import { useState } from "react";
import { get, type PluginRow } from "../lib/api.js";
import { useAsync, AsyncBoundary } from "../components/Async.js";
import { Link } from "../lib/router.js";

type Sort = "downloads" | "recent" | "relevance";

export function MarketplacePage() {
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<Sort>("downloads");

  const list = useAsync(
    () =>
      get<{ plugins: PluginRow[] }>(
        `/v1/marketplace/plugins?limit=50&sort=${sort}${applied ? `&q=${encodeURIComponent(applied)}` : ""}`,
      ),
    [applied, sort],
  );

  return (
    <div className="main-narrow">
      <h1>마켓플레이스</h1>
      <p className="page-sub">조직에 설치할 플러그인을 찾습니다. 설치는 관리자 권한이 필요합니다.</p>

      <form
        className="row"
        style={{ marginBottom: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
          // 검색어가 있으면 관련도 정렬이 자연스럽다. 다운로드순 고정이면
          // 검색 결과 1위가 질의와 무관한 인기 플러그인이 된다.
          if (query.trim() && sort === "downloads") setSort("relevance");
        }}
      >
        <input
          aria-label="플러그인 검색"
          placeholder="이름, 슬러그, 설명으로 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label="정렬 기준" value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ width: 150 }}>
          <option value="downloads">다운로드순</option>
          <option value="recent">최신순</option>
          <option value="relevance">관련도순</option>
        </select>
        <button type="submit">검색</button>
      </form>

      <AsyncBoundary loading={list.loading} error={list.error} empty={list.data?.plugins.length === 0}>
        <div className="grid grid-3">
          {list.data?.plugins.map((p) => (
            <Link key={p.id} to={`/marketplace/${p.slug}`} className="card" style={{ color: "inherit" }}>
              <div className="row-between">
                <strong>{p.name}</strong>
                {p.latest_version ? (
                  <span className="badge mono">{p.latest_version}</span>
                ) : (
                  <span className="badge warn">승인 대기</span>
                )}
              </div>
              <div className="mono small muted">{p.slug}</div>
              <p className="small" style={{ margin: "8px 0", minHeight: 34 }}>
                {p.description ?? "설명 없음"}
              </p>
              <div className="row-between small muted">
                <span>↓ {Number(p.downloads).toLocaleString()}</span>
                <span>
                  {Number(p.rating_count) > 0 ? `★ ${p.rating} (${p.rating_count})` : "평가 없음"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </AsyncBoundary>
    </div>
  );
}
