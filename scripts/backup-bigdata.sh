#!/usr/bin/env bash
# 공공통계 데이터셋 백업.
#
# scripts/backup.sh 는 Postgres 만 다룬다. bigdata 산출물(Parquet·DuckDB·임베딩)은
# 다른 곳에 있고 다른 방식으로 만들어지므로 별도 스크립트가 필요하다.
#
# 무엇을 백업하고 무엇을 하지 않는가:
#   Parquet (898MB)  → 백업한다. 원본 CSV 에서 다시 만들 수 있지만 45분 걸린다.
#   catalog.parquet  → 백업한다. series_id 가 여기서 정해지므로 잃으면 팩트와 어긋난다.
#   DuckDB (2.5GB)   → **백업하지 않는다.** Parquet 에서 8분이면 다시 만든다.
#                       임베딩만 따로 뜬다(6,597 × 1024, 재생성에 4분 + Ollama 필요).
#   원본 CSV         → 백업하지 않는다. 사용자의 원본이고 우리가 만든 것이 아니다.
set -euo pipefail

ROOT="${BIGDATA_ROOT:-/Volumes/T7/bigdata}"
DEST="${1:?사용법: backup-bigdata.sh <백업_디렉터리>}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/bigdata-$STAMP"

[ -d "$ROOT/parquet" ] || { echo "데이터셋이 없다: $ROOT/parquet" >&2; exit 1; }

mkdir -p "$OUT"
echo "백업 → $OUT"

# Parquet 전체. --link 를 쓰지 않는 이유: 같은 볼륨이면 하드링크가 백업이 아니다.
cp -R "$ROOT/parquet" "$OUT/parquet"

# 임베딩만 DuckDB 에서 뽑는다. 전체 DB(2.5GB)는 Parquet 에서 재생성 가능하지만,
# 임베딩은 Ollama 가 떠 있어야 만들 수 있어 복구 조건이 더 까다롭다.
# duckdb 가 설치된 인터프리터를 쓴다. 시스템 python3 에는 없다 —
# 여기서 조용히 실패하면 '백업했다'고 믿으면서 임베딩만 빠진 백업을 갖게 된다.
PY_BIN="${BIGDATA_PYTHON:-$ROOT/env/bin/python}"
if [ ! -x "$PY_BIN" ]; then
  echo "경고: $PY_BIN 이 없다. BIGDATA_PYTHON 으로 duckdb 가 설치된 인터프리터를 지정하라." >&2
  echo "      임베딩은 백업되지 않는다." >&2
fi

if [ -f "$ROOT/bigdata.duckdb" ] && [ -x "$PY_BIN" ]; then
  "$PY_BIN" - "$ROOT/bigdata.duckdb" "$OUT/catalog_embeddings.parquet" <<'PY' || echo "  (임베딩 테이블 없음 — 건너뜀)"
import sys, duckdb
src, dest = sys.argv[1], sys.argv[2]
con = duckdb.connect(src, read_only=True)
n = con.execute("select count(*) from duckdb_tables() where table_name='catalog_embeddings'").fetchone()[0]
if not n:
    raise SystemExit(1)
con.execute(f"copy catalog_embeddings to '{dest}' (format parquet, compression zstd)")
print(f"  임베딩 {con.execute('select count(*) from catalog_embeddings').fetchone()[0]:,}행")
PY
fi

# 무엇이 들어 있고 어떻게 복구하는지 함께 남긴다.
# 백업만 있고 복구 절차가 없으면 급할 때 쓸 수 없다.
cat > "$OUT/RESTORE.md" <<'MD'
# 복구 절차

이 백업에는 Parquet 과 임베딩만 있다. DuckDB 파일은 없다 — Parquet 에서 재생성한다.

```bash
# 1) Parquet 복원
cp -R parquet /Volumes/T7/bigdata/

# 2) DuckDB 재생성 (약 8분)
python tools/bigdata/build.py db

# 3) 임베딩 복원 — Ollama 없이도 된다
#
#    **차원을 명시해 캐스팅해야 한다.** Parquet 왕복에서 고정 크기 배열
#    FLOAT[1024] 이 가변 FLOAT[] 로 풀리고, 그러면 array_cosine_similarity 가
#    "No function matches" 로 실패한다. 행 수는 맞으므로 검증 없이는 성공으로 보인다.
python - <<'PYEOF'
import duckdb
con = duckdb.connect('/Volumes/T7/bigdata/bigdata.duckdb')
dim = con.execute(
    "select len(embedding) from read_parquet('catalog_embeddings.parquet') limit 1"
).fetchone()[0]
con.execute("drop table if exists catalog_embeddings")
con.execute(
    f"create table catalog_embeddings as "
    f"select series_id, embedding::FLOAT[{dim}] as embedding "
    f"from read_parquet('catalog_embeddings.parquet')"
)
print("임베딩 복원:", con.execute("select count(*) from catalog_embeddings").fetchone()[0], f"({dim}차원)")
PYEOF

# 4) 확인
BIGDATA_DB_PATH=/Volumes/T7/bigdata/bigdata.duckdb pnpm --filter @aios/verify s4:bigdata
```

임베딩 백업이 없다면 `python tools/bigdata/build.py embed` (Ollama 필요, 약 4분).
MD

du -sh "$OUT" | awk '{print "  크기:", $1}'
echo "완료. 복구 절차: $OUT/RESTORE.md"
