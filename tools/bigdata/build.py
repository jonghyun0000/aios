#!/usr/bin/env python3
"""
빅데이터 창구 → Parquet 파이프라인 (T7 전용, 1억 행 기준 설계).

── 저장 위치 원칙 ────────────────────────────────────────────────
모든 산출물은 T7(외장, 554GB 여유)에만 쓴다. Mac 내장 디스크는 여유가 13GB뿐이라
여기에 데이터를 쓰면 부팅 디스크를 위협한다. assert_on_t7()이 이를 코드로 강제한다 —
경로를 잘못 넘기면 조용히 Mac을 채우는 대신 즉시 실패한다.

── 왜 Postgres가 아니라 Parquet인가 ──────────────────────────────
 1) 저장 공간: colima VM 디스크는 여유 10.6GB이고 그 이미지가 Mac 내장에 있다.
    T7은 554GB가 남지만 exFAT이라 Postgres를 올리면 안 된다(하드링크 없음,
    fsync 보장 없음 → 언젠가 조용히 손상된다). Parquet은 write-once라 exFAT에서 안전하다.
 2) 질의 성격: "지역별·시점별 집계/비교"가 대부분인 분석형이라 컬럼 저장이 압도적으로 유리하다.
 3) Postgres는 카탈로그(수천 행)와 임베딩만 담는다. 6,900만 개 숫자를 임베딩하는 것은
    의미가 없다. 의미가 있는 것은 "어떤 통계표가 무엇을 담는가"라는 메타데이터다.

── 1억 행 기준 스키마 설계 ───────────────────────────────────────
시리즈마다 고정인 컬럼(출처·통계표·데이터명·단위·주기)을 팩트에서 빼고 series_id(INT32)로
대체했다. 1억 행에서 문자열 5개를 반복 저장하면 딕셔너리 인코딩을 감안해도 수백 MB가
낭비된다. 조회 편의는 카탈로그 조인으로 되돌려준다.

── 사용 ──────────────────────────────────────────────────────────
  python build.py catalog          # 파일 목록 → 카탈로그
  python build.py facts            # gz CSV → Parquet (카탈로그 필요)
  python build.py enrich           # Parquet에서 커버리지 통계 → 카탈로그 보강
  python build.py db               # Parquet → DuckDB 파일 (AI 질의용, 격리 가능)
  python build.py embed            # 카탈로그 의미검색용 임베딩 (Ollama 필요)
  python build.py rebuild          # db + embed — db가 임베딩을 지우므로 보통 이걸 쓴다
  python build.py verify           # 원본 대비 행수/합계 검증
  python build.py stats            # 적재 결과 요약
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request
import unicodedata
import sys
import time

import duckdb

# 공개 소스에 계정명을 고정하지 않고 기존 홈 기준 폴더 구조와 환경 변수 우선권을 유지한다.
SRC = os.environ.get(
    "BIGDATA_SRC",
    str(Path.home() / "Desktop/프로젝트 폴더/빅데이터 창구/92_정제"),
)
ROOT = os.environ.get("BIGDATA_ROOT", "/Volumes/T7/bigdata")
OUT = f"{ROOT}/parquet"
TMP = f"{ROOT}/_tmp"
CATALOG = f"{OUT}/catalog.parquet"

# 팩트 글로브를 `*.parquet`이 아니라 정확한 파일명으로 고정한다.
# macOS가 exFAT 볼륨에 남기는 AppleDouble 사이드카(._data.parquet)가 `*.parquet`에
# 걸려 "No magic bytes found at end of file"로 모든 질의가 실패한다.
# 파일을 지워도 접근할 때마다 다시 생기므로 패턴으로 배제하는 것이 유일한 해법이다.
# `data*.parquet` 로 넓혀도 안전하다 — AppleDouble은 `._` 로 시작하므로 매칭되지 않는다.
# (해양관측이 같은 카테고리에 data-marine.parquet 으로 들어온다.)
FACTS = f"{OUT}/facts/*/data*.parquet"
# 읽을 때 하이브 파티션 자동 인식을 끈다.
#
# 디렉터리를 `category=<이름>` 으로 두면 DuckDB가 자동으로 하이브 파티션으로 해석해
# **디렉터리명에서 뽑은 값이 파일에 저장된 컬럼을 가린다.** exFAT의 디렉터리명은 NFD라
# 결국 NFD 값이 돌아오고, 사용자의 NFC 질의가 조용히 0행이 된다.
# 그래서 (1) 디렉터리에서 `category=` 접두사를 빼고 (2) 읽기에서도 명시적으로 끈다.
READ = f"read_parquet('{FACTS}', hive_partitioning=false)"


def nfc(s: str) -> str:
    """
    macOS 파일명 유니코드 정규화 보정.

    macOS는 파일명을 NFD(자모 분리)로 돌려준다. '01_인구_사회'가 8코드포인트가 아니라
    13코드포인트다. 반면 사람이 타이핑하거나 CSV 안에 들어 있는 한글은 NFC다.
    이 둘을 그대로 비교하면 `where category = '01_인구_사회'` 가 **에러 없이 0행**을
    반환한다 — 실제로 그렇게 됐다. 조용히 틀린 답을 주는 것이 가장 위험하므로
    경로에서 유래한 모든 문자열은 저장 전에 NFC로 통일한다.
    """
    return unicodedata.normalize("NFC", s)

# 6,568개 파일 전수 검사로 확인한 표준 스키마.
COLUMNS = ("출처", "통계표", "데이터명", "지역", "지역코드", "지역코드원본", "시도",
           "분류1", "분류2", "분류3", "항목", "단위", "주기", "시점", "시점값", "값")

# CSV 파싱 옵션을 명시적으로 고정한다.
#
# 자동 추정에 맡기면 파일마다 다른 결론을 낸다. 실제로 06_국제비교의 OWID 파일에서
# quote를 (empty)로 추정해 "Less developed regions, excluding China" 안의 쉼표가
# 컬럼을 갈랐고, 17번째 컬럼이 생겨 변환이 통째로 실패했다.
# ignore_errors로 넘기면 그 행들이 조용히 사라지므로 규칙을 고정하는 것이 유일한 정답이다.
CSV_OPTS = "header=true, all_varchar=true, delim=',', quote='\"', escape='\"'"


# 시도 정규화 규칙.
#
# 왜 필요한가: 같은 곳에 표기가 여러 가지다 — 서울/서울특별시, 강원/강원도/강원특별자치도.
# `where region='서울'` 로 조회하면 서울특별시 97만 행을 **조용히 놓친다.**
# sido_norm 을 쓰면 표기와 무관하게 하나로 묶인다.
#
# 왜 이것으로 100%가 되지 않는가: '동구'(150만 행)는 부산·대구·인천·광주·대전·울산 6곳에,
# '고성군'은 강원과 경남 양쪽에 존재한다. 부모 시도 없이는 **원리적으로 결정 불가**다.
# 추측해서 채우면 조용히 틀린 집계를 만들므로 NULL로 남긴다.
#
# 긴 이름을 먼저 검사한다. '강원'을 먼저 보면 '강원특별자치도'가 거기서 걸려버린다.
_SIDO_RULES = [
    ("서울특별시", "서울"), ("부산광역시", "부산"), ("대구광역시", "대구"), ("인천광역시", "인천"),
    ("대전광역시", "대전"), ("울산광역시", "울산"), ("세종특별자치시", "세종"), ("경기도", "경기"),
    ("강원특별자치도", "강원"), ("강원도", "강원"), ("충청북도", "충북"), ("충청남도", "충남"),
    ("전북특별자치도", "전북"), ("전라북도", "전북"), ("전라남도", "전남"),
    ("경상북도", "경북"), ("경상남도", "경남"), ("제주특별자치도", "제주"), ("제주도", "제주"),
    ("서울", "서울"), ("부산", "부산"), ("대구", "대구"), ("인천", "인천"), ("대전", "대전"),
    ("울산", "울산"), ("세종", "세종"), ("경기", "경기"), ("강원", "강원"), ("충북", "충북"),
    ("충남", "충남"), ("전북", "전북"), ("전남", "전남"), ("경북", "경북"), ("경남", "경남"),
    ("제주", "제주"), ("전국", "전국"),
]


def sido_norm_sql(col: str = "region") -> str:
    """
    region → 표준 시도 축약형 SQL 식.

    '광주'는 접두사 매칭에서 제외한다. 광주광역시와 경기도 광주시가 충돌하기 때문이다
    (실측: 광주광역시 985,417행 / 광주시 274,029행). 정확히 '광주'이거나
    '광주광역시…'로 시작할 때만 광주로 보고, '광주시'는 NULL로 남긴다.
    """
    cases = " ".join(
        f"when {col} like '{full}%' then '{short}'"
        for full, short in _SIDO_RULES
        if full != "광주"
    )
    return (
        f"case when {col} = '광주' or {col} like '광주광역시%' then '광주' "
        f"{cases} end"
    )


def assert_on_t7(path: str) -> None:
    """T7 밖에 쓰려는 시도를 즉시 막는다. 실수로 Mac 부팅 디스크를 채우지 않기 위해서다."""
    real = os.path.realpath(path)
    if not real.startswith("/Volumes/T7/"):
        raise SystemExit(f"거부: 출력 경로가 T7 밖이다 → {real}")


def connect() -> duckdb.DuckDBPyConnection:
    assert_on_t7(ROOT)
    os.makedirs(TMP, exist_ok=True)
    con = duckdb.connect()
    con.sql(f"set temp_directory='{TMP}'")         # 스필도 T7으로
    con.sql("set memory_limit='4GB'")              # 16GB 머신에서 다른 작업과 공존
    con.sql("set preserve_insertion_order=false")  # 스트리밍 COPY 메모리 절감
    return con


def list_files() -> list[tuple[str, str]]:
    """(카테고리, 절대경로) 목록. 카테고리는 92_정제 바로 아래 폴더명."""
    out = []
    for dirpath, _, filenames in os.walk(SRC):
        for f in filenames:
            if f.endswith(".csv.gz") and not f.startswith("._"):
                full = os.path.join(dirpath, f)
                out.append((nfc(os.path.relpath(full, SRC).split(os.sep)[0]), full))
    out.sort(key=lambda t: t[1])  # 정렬 고정 → series_id가 재실행해도 동일
    return out


def build_catalog(con: duckdb.DuckDBPyConnection) -> None:
    """
    카탈로그: 파일 1개 = 시리즈 1개.

    series_id를 해시가 아니라 '정렬된 순번'으로 주는 이유: INT32면 팩트에서 4바이트다.
    해시 문자열(16자)은 1억 행에서 그 자체로 큰 비용이다. 파일 목록을 경로로 정렬해
    번호를 매기므로 재실행해도 같은 ID가 나온다.
    """
    files = list_files()
    print(f"카탈로그 대상 {len(files):,}개 파일")
    t0 = time.time()
    rows, failed = [], []
    for i, (category, path) in enumerate(files):
        if i and i % 500 == 0:
            print(f"  {i:,}/{len(files):,} ({time.time()-t0:.0f}초)", flush=True)
        try:
            # 집계가 아니라 첫 행만 읽는다.
            # min/max/count를 여기서 구하면 파일 전체를 압축 해제해야 하고,
            # 그러면 facts 변환과 합쳐 10.7GB를 두 번 읽게 된다.
            # 커버리지 통계는 변환이 끝난 Parquet에서 컬럼 스캔으로 싸게 채운다(enrich).
            m = con.execute(
                f"select 출처, 통계표, 데이터명, 단위, 주기 from read_csv(?, {CSV_OPTS}) limit 1",
                [path],
            ).fetchone()
        except Exception as e:  # noqa: BLE001 — 한 파일 실패로 전체를 멈추지 않는다
            failed.append((path, str(e).split("\n")[0][:150]))
            continue
        if m is None:  # 데이터가 한 행도 없는 파일
            m = (None,) * 5
        rows.append({
            "series_id": i,  # 정렬 순번 = 안정적 surrogate key
            "category": category,
            "source": m[0], "table_code": m[1], "series_name": m[2],
            "unit": m[3], "period_type": m[4],
            "rel_path": nfc(os.path.relpath(path, SRC)),
        })

    import pandas as pd
    con.register("catalog_rows", pd.DataFrame(rows))
    assert_on_t7(CATALOG)
    con.execute(f"copy (select * from catalog_rows order by series_id) "
                f"to '{CATALOG}' (format parquet, compression zstd)")
    print(f"카탈로그 {len(rows):,}시리즈 → {CATALOG} ({time.time()-t0:.0f}초)")
    if failed:
        print(f"\n실패 {len(failed)}건:")
        for p, e in failed[:20]:
            print(f"  {os.path.basename(p)[:60]} → {e}")
        raise SystemExit(1)  # 조용히 빠뜨리지 않는다


def build_facts(con: duckdb.DuckDBPyConnection, only: str | None = None) -> None:
    """
    카테고리별 Parquet 1개.

    파일당 하나씩(6,568개) 만들지 않는 이유: 작은 파일이 많으면 메타데이터·열기 비용이
    질의 시간을 지배한다. 전부 하나로 합치면 카테고리 프루닝을 잃는다. 카테고리 단위가 균형점이다.
    """
    if not os.path.exists(CATALOG):
        raise SystemExit(f"카탈로그가 없다. 먼저 `catalog`를 실행하라: {CATALOG}")

    con.execute(f"create or replace temp table cat as select * from read_parquet('{CATALOG}')")

    files = list_files()
    by_cat: dict[str, list[str]] = {}
    for category, path in files:
        if only and category != only:
            continue
        by_cat.setdefault(category, []).append(path)
    if not by_cat:
        raise SystemExit(f"대상 없음 (only={only})")

    os.makedirs(f"{OUT}/facts", exist_ok=True)
    grand_rows = grand_bytes = 0
    src_prefix = SRC.rstrip("/") + "/"

    for category, paths in sorted(by_cat.items()):
        t0 = time.time()
        target = f"{OUT}/facts/{category}"
        assert_on_t7(target)
        os.makedirs(target, exist_ok=True)
        dest = f"{target}/data.parquet"

        con.execute(
            f"""
            copy (
              select
                cat.series_id::int              as series_id,
                -- 카테고리를 실제 컬럼으로 넣는다. 하이브 파티션 값에 의존하면
                -- 디렉터리명이 NFD라 사용자의 NFC 질의와 매칭되지 않는다.
                ?                               as category,
                -- 값은 숫자로 강제 변환한다. 비수치는 null이 되며 원문은 raw_value에 남긴다.
                -- (07_환경_에너지 검증: null 53,229건 전부 원본이 빈 값, 손실 0건)
                try_cast(f.값 as double)         as value,
                f.값                             as raw_value,
                f.지역                           as region,
                f.지역코드                       as region_code,
                f.시도                           as sido,
                f.분류1 as cls1, f.분류2 as cls2, f.분류3 as cls3,
                f.항목                           as item,
                f.시점                           as period,
                try_cast(f.시점값 as bigint)      as period_value
              from read_csv(?, {CSV_OPTS}, filename=true, union_by_name=true) f
              -- 시리즈 고정 컬럼(출처·통계표·데이터명·단위·주기)은 카탈로그에만 둔다.
              -- 양쪽을 NFC로 정규화해 조인한다. 한쪽만 하면 전부 어긋난다.
              join cat on cat.rel_path = nfc_normalize(replace(f.filename, ?, ''))
            ) to '{dest}' (format parquet, compression zstd, row_group_size 200000)
            """,
            [category, paths, src_prefix],
        )
        n = con.execute(f"select count(*) from read_parquet('{dest}')").fetchone()[0]
        size = os.path.getsize(dest)
        grand_rows += n
        grand_bytes += size
        print(f"  {category:<20} {len(paths):>5}파일 {n:>12,}행 "
              f"{size/1024/1024:>8.1f}MB {time.time()-t0:>6.0f}초", flush=True)

    print(f"\n합계: {grand_rows:,}행, {grand_bytes/1024/1024/1024:.2f}GB")


def verify(con: duckdb.DuckDBPyConnection) -> int:
    """
    행수만 비교하지 않는다. 행수가 같아도 값이 밀리거나 null이 됐을 수 있으므로
    원본에서 행수와 숫자 합계를 다시 계산해 대조하고, 시리즈 누락도 확인한다.
    """
    files = list_files()
    by_cat: dict[str, list[str]] = {}
    for category, path in files:
        by_cat.setdefault(category, []).append(path)

    failures = 0
    print(f"{'카테고리':<20} {'원본행':>12} {'Parquet행':>12} {'합계':>6} {'시리즈':>10} {'null%':>7}")
    for category, paths in sorted(by_cat.items()):
        dest = f"{OUT}/facts/{category}/data.parquet"
        if not os.path.exists(dest):
            print(f"{category:<20} {'':>12} {'MISSING':>12}")
            failures += 1
            continue
        src = con.execute(
            f"select count(*), sum(try_cast(값 as double)) from read_csv(?, {CSV_OPTS}, union_by_name=true)",
            [paths],
        ).fetchone()
        dst = con.execute(
            f"""select count(*), sum(value), count(distinct series_id),
                       sum(case when value is null then 1 else 0 end)
                from read_parquet('{dest}')"""
        ).fetchone()
        rows_ok = src[0] == dst[0]
        a, b = src[1] or 0.0, dst[1] or 0.0
        # 부동소수 합계는 더하는 순서에 따라 미세하게 달라지므로 상대오차로 비교한다.
        sum_ok = abs(a - b) <= max(1e-6, abs(a) * 1e-9)
        series_ok = dst[2] == len(paths)
        null_pct = 100.0 * dst[3] / dst[0] if dst[0] else 0.0
        if not (rows_ok and sum_ok and series_ok):
            failures += 1
        print(f"{category:<20} {src[0]:>12,} {dst[0]:>12,} "
              f"{'OK' if (sum_ok and rows_ok) else 'FAIL':>6} "
              f"{f'{dst[2]}/{len(paths)}':>10} {null_pct:>6.2f}%", flush=True)
    return failures


def enrich(con: duckdb.DuckDBPyConnection) -> None:
    """
    변환된 Parquet에서 커버리지 통계를 계산해 카탈로그에 붙인다.
    CSV를 다시 읽지 않고 컬럼 스캔만 하므로 몇 초면 끝난다.
    """
    t0 = time.time()
    con.execute(f"""
        create or replace temp table cov as
        select series_id,
               min(period) as period_min, max(period) as period_max,
               count(*) as row_count,
               -- region_code가 아니라 region(지역명)을 센다.
               -- region_code는 출처마다 체계가 달라 전 행이 'KOR' 하나인 통계표가 흔하다.
               -- 그 값을 '지역 1개'라고 보여주면 실제로 50개 지역을 고를 수 있는 화면과
               -- 어긋난다 — 실제로 UI에 "지역 1"과 "전체 지역(50)"이 동시에 떴다.
               count(distinct region) as region_count,
               count(distinct region_code) as region_code_count,
               count(distinct item) as item_count,
               sum(case when value is null then 1 else 0 end) as null_count
        from {READ}
        group by 1""")
    assert_on_t7(CATALOG)
    # 기본 컬럼을 명시한다. `select c.*` 를 쓰면 이전 enrich 가 덧붙인 컬럼까지 딸려와
    # 재실행마다 period_min_1, region_count_2 … 가 쌓인다. 그리고 앞자리의 옛 값이
    # 계속 이기므로 **수정한 계산식이 반영되지 않는다** — 실제로 그렇게 당했다.
    # 멱등성은 여기서 컬럼을 고정해야만 성립한다.
    con.execute(f"""
        copy (
          select c.series_id, c.category, c.source, c.table_code, c.series_name,
                 c.unit, c.period_type, c.rel_path,
                 v.period_min, v.period_max,
                 coalesce(v.row_count, 0) as row_count,
                 coalesce(v.region_count, 0) as region_count,
                 coalesce(v.region_code_count, 0) as region_code_count,
                 coalesce(v.item_count, 0) as item_count,
                 coalesce(v.null_count, 0) as null_count
          from read_parquet('{CATALOG}') c
          left join cov v using (series_id)
          order by c.series_id
        ) to '{CATALOG}.new' (format parquet, compression zstd)""")
    os.replace(f"{CATALOG}.new", CATALOG)
    n = con.execute(f"select count(*), sum(row_count) from read_parquet('{CATALOG}')").fetchone()
    print(f"카탈로그 보강: {n[0]:,}시리즈 / 팩트 {n[1]:,}행 ({time.time()-t0:.0f}초)")


def stats(con: duckdb.DuckDBPyConnection) -> None:
    r = con.execute(
        f"select count(*), count(distinct series_id) from {READ}"
    ).fetchone()
    size = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fn in os.walk(f"{OUT}/facts") for f in fn
        if f.startswith("data") and f.endswith(".parquet")
    )
    print(f"팩트    : {r[0]:,}행 / {r[1]:,}시리즈 / {size/1024**3:.2f}GB")
    if os.path.exists(CATALOG):
        cat = con.execute(f"select count(*) from read_parquet('{CATALOG}')").fetchone()[0]
        print(f"카탈로그: {cat:,}시리즈")
    print(f"\n{'카테고리':<22} {'행수':>14} {'시리즈':>8}")
    for row in con.execute(f"""
        select category, count(*) n, count(distinct series_id) s
        from {READ}
        group by 1 order by n desc""").fetchall():
        print(f"{row[0]:<22} {row[1]:>14,} {row[2]:>8,}")


def build_db(con: duckdb.DuckDBPyConnection) -> None:
    """
    Parquet → DuckDB 데이터베이스 파일.

    왜 Parquet을 직접 질의하지 않고 물질화하는가 — 보안이다.
    AI에게 SQL을 맡기려면 `read_csv('/etc/passwd')`, `COPY ... TO '/tmp/x'`,
    `INSTALL httpfs` 같은 시도를 막아야 한다. DuckDB의 `enable_external_access=false`가
    이를 한 번에 차단하지만, 그 설정은 read_parquet도 함께 막는다.
    데이터를 DB 파일 안에 넣어두면 질의 시점에 파일 접근이 아예 필요 없어져
    외부 접근을 완전히 꺼도 모든 분석 질의가 동작한다.

    부수 효과로 속도도 빨라진다(네이티브 저장 + 존 맵).
    """
    dest = f"{ROOT}/bigdata.duckdb"
    assert_on_t7(dest)
    if os.path.exists(dest):
        os.remove(dest)
    t0 = time.time()
    db = duckdb.connect(dest)
    db.sql(f"set temp_directory='{TMP}'")
    db.sql("set memory_limit='4GB'")
    db.sql("set preserve_insertion_order=false")
    db.execute(f"create table catalog as select * from read_parquet('{CATALOG}')")
    # sido_norm은 파생 컬럼이라 Parquet이 아니라 여기서 만든다.
    # Parquet은 원본에 충실하게 두고, 분석 편의는 질의 계층이 제공한다 —
    # 규칙이 바뀌어도 원본을 다시 만들 필요가 없다.
    db.execute(
        f"create table facts as select *, {sido_norm_sql('region')}::varchar as sido_norm from {READ}"
    )
    n = db.execute("select count(*) from facts").fetchone()[0]
    c = db.execute("select count(*) from catalog").fetchone()[0]
    db.close()
    size = os.path.getsize(dest)
    print(f"DB 생성: {dest}")
    print(f"  facts {n:,}행 / catalog {c:,}행 / {size/1024**3:.2f}GB ({time.time()-t0:.0f}초)")
    # 이 명령은 DB 파일을 통째로 새로 만든다. catalog_embeddings 는 embed 단계에서
    # DB 안에 만들어지므로 **함께 사라진다.**
    # 도구는 임베딩이 없으면 조용히 부분일치 검색으로 내려가므로, 경고하지 않으면
    # "검색이 왜 나빠졌지"를 한참 뒤에야 알게 된다 — 실제로 그렇게 잃었다.
    print("\n  주의: 임베딩 테이블이 초기화됐다. 의미 검색을 쓰려면 `embed`를 다시 실행하라.")
    print("        (db + embed 를 한 번에 하려면 `rebuild`)")


def build_embeddings(con: duckdb.DuckDBPyConnection, batch: int = 64) -> None:
    """
    카탈로그 6,568개 통계표명을 임베딩해 DuckDB 안에 저장한다.

    왜 필요한가: bigdata_search는 부분 문자열 일치라 "집값"으로는 "전세가격지수"를 못 찾는다.
    사용자는 통계청이 붙인 정확한 명칭을 모르는 것이 정상이다. 의미 검색이 그 간극을 메운다.

    왜 팩트가 아니라 카탈로그만 임베딩하는가: 1억 4천만 개 숫자를 임베딩하는 것은
    의미가 없다. 의미가 있는 것은 "어떤 통계표가 무엇을 담는가"라는 메타데이터다.

    왜 Postgres가 아니라 DuckDB 안에 두는가: 질의 시점에 조인이 필요 없고,
    도구가 이미 열어둔 연결을 그대로 쓸 수 있다. 6,568 × 1024 float = 27MB로 작다.
    """
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    model = os.environ.get("LOCAL_EMBED_MODEL", "bge-m3")
    dbp = f"{ROOT}/bigdata.duckdb"
    assert_on_t7(dbp)
    if not os.path.exists(dbp):
        raise SystemExit("bigdata.duckdb가 없다. 먼저 `db`를 실행하라.")

    db = duckdb.connect(dbp)
    db.sql(f"set temp_directory='{TMP}'")
    rows = db.execute(
        """select series_id,
                  -- 이름만으로는 맥락이 부족하다. 카테고리·단위를 함께 넣어야
                  -- '지수'와 '비율'처럼 이름이 비슷한 통계표가 구분된다.
                  concat_ws(' | ', series_name, category, unit, source) as text
             from catalog order by series_id"""
    ).fetchall()
    print(f"임베딩 대상 {len(rows):,}개 (모델 {model})")

    t0 = time.time()
    vectors: list[tuple[int, list[float]]] = []
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        req = urllib.request.Request(
            f"{url}/api/embed",
            data=json.dumps({"model": model, "input": [r[1] for r in chunk]}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            embs = json.loads(resp.read())["embeddings"]
        if len(embs) != len(chunk):
            raise SystemExit(f"임베딩 개수 불일치: {len(embs)} != {len(chunk)}")
        vectors.extend((chunk[j][0], embs[j]) for j in range(len(chunk)))
        done = i + len(chunk)
        if done % 640 == 0 or done == len(rows):
            rate = done / max(time.time() - t0, 0.001)
            print(f"  {done:,}/{len(rows):,} ({rate:.0f}/초)", flush=True)

    dim = len(vectors[0][1])
    import pandas as pd
    db.register("emb_rows", pd.DataFrame({"series_id": [v[0] for v in vectors],
                                          "embedding": [v[1] for v in vectors]}))
    db.execute("drop table if exists catalog_embeddings")
    db.execute(
        f"create table catalog_embeddings as "
        f"select series_id, embedding::FLOAT[{dim}] as embedding from emb_rows"
    )
    n = db.execute("select count(*) from catalog_embeddings").fetchone()[0]
    db.close()
    print(f"임베딩 저장: {n:,}행 × {dim}차원 ({time.time()-t0:.0f}초)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["catalog", "facts", "enrich", "db", "embed", "rebuild", "verify", "stats"])
    ap.add_argument("--only", help="특정 카테고리만 처리 (시험용)")
    args = ap.parse_args()

    con = connect()
    if args.command == "catalog":
        build_catalog(con)
    elif args.command == "facts":
        build_facts(con, args.only)
    elif args.command == "enrich":
        enrich(con)
    elif args.command == "db":
        build_db(con)
    elif args.command == "embed":
        build_embeddings(con)
    elif args.command == "rebuild":
        # db가 임베딩을 날리므로 둘을 항상 붙여 실행할 수 있게 한다.
        build_db(con)
        build_embeddings(con)
    elif args.command == "stats":
        stats(con)
    else:
        n = verify(con)
        print(f"\n{'검증 통과' if n == 0 else f'검증 실패 {n}건'}")
        return 1 if n else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
