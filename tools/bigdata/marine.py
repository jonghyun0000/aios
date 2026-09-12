#!/usr/bin/env python3
"""
KMA 해양관측(부이·등표) → Parquet.

── 왜 별도 스크립트인가 ──────────────────────────────────────────
92_정제의 KOSIS 데이터는 이미 long format(16컬럼)이라 그대로 옮기면 됐다.
해양관측은 **wide format 관측 원본**이다: 한 행에 시각·지점과 15개 측정값이 나란히 있다.
long으로 녹이는(melt) 과정에서 결측 표기·물리 범위·단위를 항목마다 다르게 다뤄야 해서,
build.py에 끼워 넣으면 두 갈래 로직이 한 함수에 섞인다.

── 시리즈 정의: (계열, 측정항목) ─────────────────────────────────
파일 단위가 아니다. 한 시리즈는 **하나의 측정 가능한 양**이어야 한다.
풍향(0~360°)과 수온(°C)을 한 시리즈에 담으면 평균·최대가 물리적으로 무의미해지고,
카탈로그의 unit 필드도 하나만 가질 수 있다.
결과: 부이 15개 + 등표 12개 ≈ 27개 시리즈가 전 연도를 관통한다.

── 결측과 이상치를 구분한다 ──────────────────────────────────────
 -99 계열(≤ -90)  = KMA 결측 표기. "측정 없음"이므로 **행을 만들지 않는다.**
                    wide에서 빈 칸이던 것을 long에서 NULL 행으로 되살릴 이유가 없다.
 물리 범위 밖     = 측정은 됐는데 값이 불가능하다(기압 10355hPa, 기온 4810°C).
                    **행은 남기되 value=NULL, raw_value에 원문을 보존한다.**
                    조용히 지우면 사용자가 원본에 이상이 있다는 사실 자체를 모른다.
"""
import argparse
import os
from pathlib import Path
import re
import sys
import time
import unicodedata

import duckdb

# 공개 소스에 계정명을 고정하지 않고 기존 홈 기준 폴더 구조와 환경 변수 우선권을 유지한다.
SRC = os.environ.get(
    "MARINE_SRC",
    str(Path.home() / "Desktop/프로젝트 폴더/빅데이터 창구/12_기상_기후/02_해양관측"),
)
ROOT = os.environ.get("BIGDATA_ROOT", "/Volumes/T7/bigdata")
OUT = f"{ROOT}/parquet"
TMP = f"{ROOT}/_tmp"
CATALOG = f"{OUT}/catalog.parquet"
CATEGORY = "12_기상_기후"
STATIONS = "해양기상관측소목록_KMA_2026.csv"

CSV_OPTS = "header=true, all_varchar=true, delim=',', quote='\"', escape='\"'"

# KMA 결측 표기. -99, -99.9 등이 쓰이며 컬럼마다 자릿수가 다르다.
# 임계값을 -90으로 잡은 근거: 실측상 -90~-50 구간에 값이 사실상 없고(부이 TA 71건, TW 9건),
# 그 아래는 전부 -99 계열이다. 실제 관측 최저는 기온 -49.7 / 수온 -43.3 이다.
SENTINEL_MAX = -90

# (컬럼, 항목명, 단위, 최소, 최대)
# 범위는 물리적으로 가능한 한계다. 벗어난 값은 관측기 고장이나 인코딩 오류로 본다.
BUOY_ITEMS = [
    ("WD1", "풍향(1분)", "deg", 0, 360),
    ("WS1", "풍속(1분)", "m/s", 0, 120),
    ("WS1_GST", "돌풍풍속(1분)", "m/s", 0, 150),
    ("WD2", "풍향(10분)", "deg", 0, 360),
    ("WS2", "풍속(10분)", "m/s", 0, 120),
    ("WS2_GST", "돌풍풍속(10분)", "m/s", 0, 150),
    ("PA", "기압", "hPa", 800, 1100),
    ("HM", "습도", "%", 0, 100),
    ("TA", "기온", "°C", -60, 60),
    ("TW", "수온", "°C", -5, 45),
    ("WH_MAX", "최대파고", "m", 0, 30),
    ("WH_SIG", "유의파고", "m", 0, 30),
    ("WH_AVE", "평균파고", "m", 0, 30),
    ("WP", "파주기", "s", 0, 30),
    ("WO", "파향", "deg", 0, 360),
    # AQC/MQC는 품질검사 플래그 문자열이라 수치 시계열이 아니다 — 제외한다.
]

LIGHTHOUSE_ITEMS = [
    ("WD", "풍향", "deg", 0, 360),
    ("WS", "풍속", "m/s", 0, 120),
    ("WD_INS", "순간풍향", "deg", 0, 360),
    ("WS_INS", "순간풍속", "m/s", 0, 150),
    ("TA", "기온", "°C", -60, 60),
    ("TA_MIN", "최저기온", "°C", -60, 60),
    ("TA_MAX", "최고기온", "°C", -60, 60),
    ("PS", "해면기압", "hPa", 800, 1100),
    ("TW", "수온", "°C", -5, 45),
    ("WH_MAX", "최대파고", "m", 0, 30),
    ("WH_SIG", "유의파고", "m", 0, 30),
    ("WP", "파주기", "s", 0, 30),
    # LS·VT는 KMA 문서에서 의미를 확정하지 못했다. 잘못된 한글 이름을 붙이면
    # 사용자가 그것을 사실로 믿으므로, 원본 코드 그대로 두고 단위는 비운다.
    ("LS", "LS", None, None, None),
    ("VT", "VT", None, None, None),
    # *_TM 컬럼은 값이 아니라 '그 값이 관측된 시각'이라 시계열 수치가 아니다 — 제외한다.
]

FAMILIES = [
    ("해양기상부이", "부이", BUOY_ITEMS),
    ("해양기상등표", "등표", LIGHTHOUSE_ITEMS),
]


def assert_on_t7(path: str) -> None:
    if not os.path.realpath(path).startswith("/Volumes/T7/"):
        raise SystemExit(f"거부: 출력 경로가 T7 밖이다 → {path}")


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def connect() -> duckdb.DuckDBPyConnection:
    assert_on_t7(ROOT)
    os.makedirs(TMP, exist_ok=True)
    con = duckdb.connect()
    con.sql(f"set temp_directory='{TMP}'")
    con.sql("set memory_limit='4GB'")
    con.sql("set preserve_insertion_order=false")
    return con


def family_files(keyword: str) -> list[str]:
    out = []
    for f in os.listdir(SRC):
        if f.endswith(".csv.gz") and keyword in f and not f.startswith("._"):
            out.append(os.path.join(SRC, f))
    return sorted(out)


def station_map(con: duckdb.DuckDBPyConnection) -> str:
    """
    지점번호 → 지점명 임시 테이블.

    지점명이 "덕적도 Deokjeokdo 12A20000" 형태라 한글 부분만 뽑는다.
    로마자와 코드를 그대로 두면 화면의 지역 드롭다운이 읽기 어려워진다.
    """
    path = os.path.join(SRC, STATIONS)
    if not os.path.exists(path):
        raise SystemExit(f"지점 목록이 없다: {path}")
    con.execute(
        f"""create or replace temp table stations as
            select 지점번호 as stn,
                   -- 첫 ASCII 글자 앞까지가 한글 지점명이다.
                   trim(regexp_extract(지점명, '^[^A-Za-z]+')) as name,
                   구분 as kind
              from read_csv(?, {CSV_OPTS})""",
        [path],
    )
    n = con.execute("select count(*) from stations").fetchone()[0]
    print(f"지점 목록 {n}개 로드")
    return "stations"


def next_series_id(con: duckdb.DuckDBPyConnection) -> int:
    """기존 카탈로그 다음 번호부터 이어 붙인다. 기존 series_id를 흔들면 팩트가 어긋난다."""
    if not os.path.exists(CATALOG):
        return 0
    return int(con.execute(f"select coalesce(max(series_id), -1) + 1 from read_parquet('{CATALOG}')").fetchone()[0])


def build(con: duckdb.DuckDBPyConnection) -> None:
    station_map(con)
    base_id = next_series_id(con)
    print(f"series_id {base_id} 부터 할당")

    target_dir = f"{OUT}/facts/{CATEGORY}"
    assert_on_t7(target_dir)
    os.makedirs(target_dir, exist_ok=True)
    # 같은 카테고리 디렉터리에 별도 파일로 둔다.
    # data.parquet 을 덮으면 build.py facts 가 만든 KOSIS 기상 데이터가 사라진다.
    dest = f"{target_dir}/data-marine.parquet"

    catalog_rows: list[dict] = []
    selects: list[str] = []
    params: list[object] = []
    sid = base_id

    for family, keyword, items in FAMILIES:
        files = family_files(keyword)
        if not files:
            print(f"  {family}: 파일 없음 — 건너뜀")
            continue
        print(f"  {family}: {len(files)}파일")
        for col, item_name, unit, lo, hi in items:
            # 범위 검사가 없는 항목(LS·VT)은 sentinel만 거른다.
            range_guard = (
                f"and try_cast(f.{col} as double) between {lo} and {hi}"
                if lo is not None
                else ""
            )
            value_expr = (
                f"case when try_cast(f.{col} as double) between {lo} and {hi} "
                f"then try_cast(f.{col} as double) end"
                if lo is not None
                else f"try_cast(f.{col} as double)"
            )
            selects.append(
                f"""
                select
                  {sid}::int                                as series_id,
                  '{CATEGORY}'                              as category,
                  {value_expr}                              as value,
                  f.{col}                                   as raw_value,
                  coalesce(s.name, '지점 ' || f.STN)         as region,
                  f.STN                                     as region_code,
                  null::varchar                             as sido,
                  '{family}'                                as cls1,
                  null::varchar                             as cls2,
                  null::varchar                             as cls3,
                  '{item_name}'                             as item,
                  -- TM(YYYYMMDDHHMM) → 'YYYY-MM-DD HH:MM'.
                  -- 문자열 정렬이 시간 정렬과 일치해야 차트가 올바른 순서로 그려진다.
                  substr(f.TM,1,4)||'-'||substr(f.TM,5,2)||'-'||substr(f.TM,7,2)
                    ||' '||substr(f.TM,9,2)||':'||substr(f.TM,11,2)  as period,
                  try_cast(f.TM as bigint)                  as period_value
                from read_csv(?, {CSV_OPTS}, union_by_name=true) f
                left join stations s on s.stn = f.STN
                -- sentinel(-99 계열)은 '측정 없음'이므로 행 자체를 만들지 않는다.
                where f.{col} is not null and try_cast(f.{col} as double) > {SENTINEL_MAX}
                """
            )
            params.append(files)
            catalog_rows.append({
                "series_id": sid,
                "category": CATEGORY,
                "source": "KMA",
                "table_code": f"KMA_{keyword}_{col}",
                "series_name": f"{family} {item_name}",
                "unit": unit,
                "period_type": "시간",
                "rel_path": f"12_기상_기후/02_해양관측/{family}_*.csv.gz",
            })
            sid += 1

    if not selects:
        raise SystemExit("변환할 항목이 없다")

    t0 = time.time()
    con.execute(
        f"copy ({' union all '.join(selects)}) to '{dest}' "
        f"(format parquet, compression zstd, row_group_size 200000)",
        params,
    )
    n = con.execute(f"select count(*) from read_parquet('{dest}')").fetchone()[0]
    size = os.path.getsize(dest)
    print(f"\n팩트: {n:,}행 / {size/1024**2:.0f}MB / {len(catalog_rows)}시리즈 ({time.time()-t0:.0f}초)")

    # 카탈로그에 이어 붙인다. 기존 행은 건드리지 않는다.
    import pandas as pd
    con.register("marine_catalog", pd.DataFrame(catalog_rows))
    assert_on_t7(CATALOG)
    con.execute(
        f"""copy (
              select series_id, category, source, table_code, series_name, unit, period_type, rel_path
                from read_parquet('{CATALOG}')
              union all
              select series_id, category, source, table_code, series_name, unit, period_type, rel_path
                from marine_catalog
              order by series_id
            ) to '{CATALOG}.new' (format parquet, compression zstd)"""
    )
    os.replace(f"{CATALOG}.new", CATALOG)
    total = con.execute(f"select count(*) from read_parquet('{CATALOG}')").fetchone()[0]
    print(f"카탈로그: {total:,}시리즈 (커버리지 통계는 build.py enrich 로 다시 채운다)")


def verify(con: duckdb.DuckDBPyConnection) -> int:
    """원본 wide 파일에서 직접 세어 melt 결과와 대조한다."""
    station_map(con)
    dest = f"{OUT}/facts/{CATEGORY}/data-marine.parquet"
    if not os.path.exists(dest):
        print("data-marine.parquet 이 없다")
        return 1

    failures = 0
    print(f"{'계열':<12} {'항목':<14} {'원본 유효':>12} {'Parquet':>12} {'범위밖':>8}")
    for family, keyword, items in FAMILIES:
        files = family_files(keyword)
        for col, item_name, unit, lo, hi in items:
            src = con.execute(
                f"""select count(*) from read_csv(?, {CSV_OPTS}, union_by_name=true)
                    where {col} is not null and try_cast({col} as double) > {SENTINEL_MAX}""",
                [files],
            ).fetchone()[0]
            dst = con.execute(
                f"""select count(*), count(*) filter (where value is null)
                      from read_parquet('{dest}')
                     where cls1 = '{family}' and item = '{item_name}'"""
            ).fetchone()
            ok = src == dst[0]
            if not ok:
                failures += 1
            print(f"{family:<12} {item_name:<14} {src:>12,} {dst[0]:>12,} {dst[1]:>8,}"
                  f"{'' if ok else '  ← 불일치'}")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["build", "verify"])
    args = ap.parse_args()
    con = connect()
    if args.command == "build":
        build(con)
        return 0
    n = verify(con)
    print(f"\n{'검증 통과' if n == 0 else f'검증 실패 {n}건'}")
    return 1 if n else 0


if __name__ == "__main__":
    sys.exit(main())
