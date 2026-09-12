#!/usr/bin/env bash
# AIOS 백업 스크립트.
#
# 설계 결정: pg_dump 논리 백업 + 오브젝트 스토리지 업로드.
#  - 논리 백업을 쓰는 이유: 버전 간 복원 가능성과 부분 복원(테이블 단위)이 가능하다.
#    물리 백업(pg_basebackup/WAL)은 PITR에 필요하므로 프로덕션에서는 '둘 다' 운용한다
#    (여기서는 관리형 Supabase가 PITR을 담당, 이 스크립트는 오프사이트 2차 사본).
#  - Redis는 백업하지 않는다: STM은 TTL로 소멸하는 캐시이고, 큐는 재생성 가능하다.
#    유실되면 안 되는 것은 전부 Postgres에 있다 — 이것이 아키텍처의 의도된 결과다.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/aios-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

# --- 클라이언트/서버 메이저 버전 검사 ---
# pg_dump는 자기 버전의 SQL을 쓴다. 상위 버전 클라이언트로 뜬 덤프는 하위 버전 서버에서
# 복원되지 않는다(PG17 클라이언트가 쓰는 `SET transaction_timeout`을 PG16이 모른다 —
# 실제로 겪었다). 이 실패는 '복원할 때'가 아니라 '백업할 때' 잡아야 한다.
# 장애 한복판에서 백업이 못 쓴다는 걸 알게 되는 것이 최악의 시나리오다.
CLIENT_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
# `show server_version_num`을 쓰는 이유: SQL 안에 작은따옴표를 넣으면 셸이 먼저 소비해
# 잘못된 쿼리가 전달된다(실제로 겪은 오류). 나눗셈은 셸에서 한다.
SERVER_VERSION_NUM="$(psql "$DATABASE_URL" -tAc "show server_version_num" 2>/dev/null | tr -d '[:space:]')"
SERVER_MAJOR=""
[ -n "$SERVER_VERSION_NUM" ] && SERVER_MAJOR=$(( SERVER_VERSION_NUM / 10000 ))

if [ -z "$SERVER_MAJOR" ]; then
  echo "[backup] FAILED: cannot reach the database at DATABASE_URL" >&2
  exit 1
fi
echo "[backup] pg_dump ${CLIENT_MAJOR} → server ${SERVER_MAJOR}"
if [ "$CLIENT_MAJOR" -gt "$SERVER_MAJOR" ]; then
  echo "[backup] FAILED: pg_dump ${CLIENT_MAJOR} produces SQL that PostgreSQL ${SERVER_MAJOR} cannot restore." >&2
  echo "[backup] Use a pg_dump whose major version matches the server, e.g." >&2
  echo "[backup]   docker compose exec -T postgres pg_dump ... > dump" >&2
  echo "[backup]   or set PATH to a PostgreSQL ${SERVER_MAJOR} client." >&2
  exit 1
fi

echo "[backup] dumping to ${FILE}"
# -Fc: 커스텀 포맷(압축 + 선택적 복원 가능), --no-owner: 복원 대상의 롤 이름에 의존하지 않음
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"

SIZE=$(wc -c < "$FILE" | tr -d ' ')
echo "[backup] wrote ${SIZE} bytes"

# 무결성: 덤프를 실제로 읽어 목록을 낼 수 있는지 확인한다.
# "백업이 존재한다"와 "백업이 복원 가능하다"는 다른 명제다 — 후자만이 의미가 있다.
echo "[backup] verifying restorability"
pg_restore --list "$FILE" > "${FILE}.toc"
TABLES=$(grep -c "TABLE DATA" "${FILE}.toc" || true)
echo "[backup] verified: ${TABLES} table-data entries readable"
if [ "$TABLES" -lt 1 ]; then
  echo "[backup] FAILED: dump contains no table data" >&2
  exit 1
fi

if [ -n "${BACKUP_S3_URI:-}" ]; then
  echo "[backup] uploading to ${BACKUP_S3_URI}/"
  aws s3 cp "$FILE" "${BACKUP_S3_URI}/aios-${STAMP}.dump"
fi

echo "[backup] pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name 'aios-*.dump*' -type f -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] done: ${FILE}"
