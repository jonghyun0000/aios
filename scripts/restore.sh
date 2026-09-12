#!/usr/bin/env bash
# AIOS 복원 스크립트.
#
# 안전 장치: 기본 동작은 '새 데이터베이스로 복원'이다. 기존 DB 덮어쓰기는
# RESTORE_TARGET을 명시적으로 지정해야만 가능하다 — 복원 스크립트가 사고의 원인이 되는
# 가장 흔한 경로는 "연습 삼아 돌렸는데 운영 DB를 지웠다"이기 때문.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file> [--force]}"
: "${DATABASE_URL:?DATABASE_URL is required (server connection, e.g. postgres://host:5432/postgres)}"
TARGET="${RESTORE_TARGET:-aios_restore_$(date -u +%Y%m%d%H%M%S)}"
FORCE="${2:-}"

if [ ! -f "$DUMP" ]; then
  echo "[restore] no such dump: $DUMP" >&2
  exit 1
fi

echo "[restore] target database: ${TARGET}"
BASE_URL="${DATABASE_URL%/*}"

# 백업 때와 같은 이유로 버전을 먼저 본다. 여기서 걸리면 복원 도중 절반만 적용된
# 데이터베이스가 남는 것보다 낫다.
CLIENT_MAJOR="$(pg_restore --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
# `show server_version_num`을 쓰는 이유: SQL 안에 작은따옴표를 넣으면 셸이 먼저 소비해
# 잘못된 쿼리가 전달된다(실제로 겪은 오류). 나눗셈은 셸에서 한다.
SERVER_VERSION_NUM="$(psql "$DATABASE_URL" -tAc "show server_version_num" 2>/dev/null | tr -d '[:space:]')"
SERVER_MAJOR=""
[ -n "$SERVER_VERSION_NUM" ] && SERVER_MAJOR=$(( SERVER_VERSION_NUM / 10000 ))
if [ -z "$SERVER_MAJOR" ]; then
  echo "[restore] FAILED: cannot reach the database at DATABASE_URL" >&2
  exit 1
fi
echo "[restore] pg_restore ${CLIENT_MAJOR} → server ${SERVER_MAJOR}"
if [ "$CLIENT_MAJOR" -gt "$SERVER_MAJOR" ]; then
  echo "[restore] FAILED: pg_restore ${CLIENT_MAJOR} against PostgreSQL ${SERVER_MAJOR} will emit unknown settings." >&2
  echo "[restore] Use a client matching the server major version." >&2
  exit 1
fi

# 안전 장치는 '이름을 지정했는가'가 아니라 '그 DB가 실제로 존재하는가'로 판단해야 한다.
# 지정만으로 막으면 새 이름으로의 정상 복원까지 차단되고(운영자는 --force를 습관적으로 붙이게 되어)
# 정작 덮어쓰기 사고를 막지 못한다 — 경고 피로(alert fatigue)를 만드는 전형적인 설계 실수다.
EXISTS=$(psql "$DATABASE_URL" -tAc "select 1 from pg_database where datname = '${TARGET}'" || echo "")
if [ "$EXISTS" = "1" ] && [ "$FORCE" != "--force" ]; then
  echo "[restore] database '${TARGET}' already exists and would be overwritten." >&2
  echo "[restore] Re-run with --force to confirm, or unset RESTORE_TARGET to restore into a fresh database." >&2
  exit 1
fi

if [ "$EXISTS" != "1" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "create database \"${TARGET}\""
fi

echo "[restore] restoring ${DUMP}"
pg_restore --dbname="${BASE_URL}/${TARGET}" --no-owner --no-privileges --exit-on-error "$DUMP"

echo "[restore] verifying"
ROWS=$(psql "${BASE_URL}/${TARGET}" -tAc "select count(*) from information_schema.tables where table_schema='public'")
echo "[restore] restored database has ${ROWS} public tables"
if [ "$ROWS" -lt 10 ]; then
  echo "[restore] FAILED: expected the full schema (>=10 tables)" >&2
  exit 1
fi

# 핵심 불변식 확인: 확장·인덱스가 함께 복원되었는가
psql "${BASE_URL}/${TARGET}" -tAc "select extname from pg_extension where extname='vector'" | grep -q vector \
  && echo "[restore] pgvector extension present" \
  || { echo "[restore] FAILED: pgvector missing after restore" >&2; exit 1; }

echo "[restore] done. Connect with: ${BASE_URL}/${TARGET}"
