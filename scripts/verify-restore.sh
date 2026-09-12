#!/usr/bin/env bash
# Postgres 백업 → 복구 왕복 검증.
#
# 왜 별도 스크립트인가: phase8 은 `docker compose exec` 로 이 검증을 하는데,
# compose 프로젝트가 어긋나 있으면(→ docs/11-deployment.md "고아 compose 스택")
# 검증 자체를 돌릴 수 없다. 백업/복구는 실제 장애에서 가장 필요한 절차라
# 배포 배선과 무관하게 확인할 수 있어야 한다. 그래서 컨테이너를 직접 지목한다.
#
# 왜 행 수만 세지 않는가: DuckDB 백업에서 행 수·합계가 전부 일치하는데
# `array_cosine_similarity` 가 실패한 적이 있다(고정 크기 배열이 가변으로 풀렸다).
# 그래서 복구본에서 **실제 벡터 질의를 돌려** 쓸 수 있는 상태인지까지 본다.
#
#   사용: scripts/verify-restore.sh [컨테이너명]     (기본값: 1ai-postgres-1)
set -euo pipefail

CONTAINER="${1:-${AIOS_PG_CONTAINER:-1ai-postgres-1}}"
TARGET="aios_restore_verify_$$"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "컨테이너 '$CONTAINER'를 찾을 수 없다." >&2
  echo "실행 중인 postgres 컨테이너:" >&2
  docker ps --filter "label=com.docker.compose.service=postgres" --format '  {{.Names}}' >&2
  exit 1
fi

echo "=== 백업 → 복구 왕복 검증 (컨테이너: $CONTAINER) ==="
docker exec -i "$CONTAINER" bash -lc "
set -euo pipefail
pg_dump --format=custom --no-owner --no-privileges -U aios -d aios --file=/tmp/$TARGET.dump
echo \"  덤프: \$(pg_restore --list /tmp/$TARGET.dump | grep -c 'TABLE DATA') 테이블\"

createdb -U aios $TARGET
pg_restore --dbname='postgres://aios:aios@localhost:5432/$TARGET' \
           --no-owner --no-privileges --exit-on-error /tmp/$TARGET.dump

q() { psql -U aios -d $TARGET -tAc \"\$1\"; }
echo \"  테이블      \$(q \"select count(*) from information_schema.tables where table_schema='public'\")\"
echo \"  pgvector    \$(q \"select coalesce((select extname from pg_extension where extname='vector'),'없음')\")\"
echo \"  벡터 차원   \$(q \"select coalesce(max(atttypmod)::text,'-') from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relname='memory_items' and a.attname='embedding'\")\"
echo \"  벡터 인덱스 \$(q \"select count(*) from pg_indexes where tablename='memory_items' and indexdef like '%vector%'\")\"
echo \"  외래키      \$(q \"select count(*) from information_schema.table_constraints where constraint_type='FOREIGN KEY' and table_schema='public'\")\"
echo \"  기억 행수   \$(q 'select count(*) from memory_items')\"

# 행 수가 아니라 '쓸 수 있는가'를 본다.
hits=\$(q \"select count(*) from (select 1 - (embedding <=> (select embedding from memory_items limit 1)) sim
            from memory_items order by embedding <=> (select embedding from memory_items limit 1) limit 5) t
          where sim is not null\")
echo \"  유사도 질의 \$hits 행\"
[ \"\$hits\" -gt 0 ] || { echo '  복구본에서 벡터 질의가 동작하지 않는다 — 복구 실패' >&2; exit 1; }

dropdb -U aios --if-exists $TARGET
rm -f /tmp/$TARGET.dump
"
echo "=== PASS — 복구본이 실제로 사용 가능하다 ==="
