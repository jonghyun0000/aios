#!/usr/bin/env bash
# 로컬 개발 환경을 한 번에 올린다 — Docker 스택 · Ollama · API 서버.
#
# 왜 필요한가: 이 환경을 손으로 복구하면 10단계가 넘고, 그중 하나(API 키)는
# **복구 자체가 불가능하다** — DB 에는 sha256 해시만 저장되므로 평문은 발급 시점에만 존재한다.
# 실제로 기기를 바꾼 뒤 /tmp 에 있던 설정과 키가 통째로 사라져 처음부터 다시 만들어야 했다.
#
# T7 전용 제약을 스크립트가 강제한다: 모델 저장소·데이터셋·키가 전부 T7 아래에 있어야 한다.
# 맥 내장 디스크에는 아무것도 남기지 않는다.
#
#   사용: scripts/dev-up.sh          기동 후 export 문을 출력한다
#         eval "$(scripts/dev-up.sh --export-only)"   이미 떠 있으면 환경만 가져온다
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
KEY_FILE="${AIOS_KEY_FILE:-/Volumes/T7/bigdata/secrets/aios-dev-key.txt}"
EXPORT_ONLY="${1:-}"
# --export-only 는 **아무것도 기동하지 않는다.** 이름 그대로 환경만 내보낸다.
#
# 왜 이렇게 갈랐나: `eval "$(dev-up.sh --export-only)"` 로 쓰이는데, 이 모드에서 서버를
# 백그라운드로 띄우면 명령 치환이 **상속된 파이프가 닫히기를 영원히 기다린다**
# (리다이렉션은 fd 0,1,2 만 덮고 그 위는 남는다). 실제로 20분을 매달렸고,
# 서버는 정상이었는데 스크립트만 반환하지 못했다.
# 이미 떠 있을 때는 기동 분기를 안 타서 여러 번 지나쳤다.
START_SERVICES=1
[ "$EXPORT_ONLY" = "--export-only" ] && START_SERVICES=0

log() { [ "$EXPORT_ONLY" = "--export-only" ] || echo "$@" >&2; }

[ -f "$ENV_FILE" ] || { echo "설정이 없다: $ENV_FILE (.env.example 참고)" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

# T7 이 붙어 있지 않으면 아무것도 하지 않는다. 마운트 없이 진행하면 맥 내장 디스크에
# 모델과 데이터가 새로 만들어져 제약을 조용히 어긴다.
[ -d /Volumes/T7 ] || { echo "T7 이 마운트되지 않았다 — 데이터·모델·키가 전부 여기 있다" >&2; exit 1; }

# ---------- 1. Docker 스택 ----------
if ! docker info >/dev/null 2>&1; then
  log "docker 가 응답하지 않는다 — colima start 를 먼저 실행하라"; exit 1
fi
if [ "$START_SERVICES" = 1 ] && [ -z "$(docker ps -q --filter name=1ai-postgres-1)" ]; then
  log "▸ postgres/redis 기동"
  ( cd "$ROOT" && DATABASE_URL=x REDIS_URL=x docker-compose up -d postgres redis >/dev/null 2>&1 )
fi
for _ in $(seq 1 60); do
  [ "$(docker inspect 1ai-postgres-1 --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ] && break
  sleep 1
done
log "  postgres: $(docker inspect 1ai-postgres-1 --format '{{.State.Health.Status}}' 2>/dev/null)"

# ---------- 2. Ollama ----------
# OLLAMA_MODELS 없이 띄우면 ~/.ollama 를 쓴다 — 모델 19GB 가 맥에 새로 받아진다.
if [ "$START_SERVICES" = 1 ] && ! curl -sf -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "▸ ollama 기동 (모델: ${OLLAMA_MODELS:-미지정})"
  # stdin 까지 끊고 완전히 떼어 놓는다 — 아래 API 서버 주석 참조.
  ( exec >/tmp/ollama.log 2>&1 </dev/null; OLLAMA_MODELS="${OLLAMA_MODELS:?T7 모델 경로가 필요하다}" nohup ollama serve & )
  for _ in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
MODELS=$(curl -sf -m 5 http://127.0.0.1:11434/api/tags | grep -o '"name"' | wc -l | tr -d ' ')
log "  ollama: 모델 ${MODELS}개"
# 모델 0개는 '기동 성공'이 아니다 — 잘못된 경로로 떴다는 뜻이다.
[ "$MODELS" -gt 0 ] || { echo "ollama 에 모델이 없다 — OLLAMA_MODELS 경로를 확인하라: ${OLLAMA_MODELS:-미지정}" >&2; exit 1; }

# ---------- 3. API 키 ----------
if [ "$START_SERVICES" = 1 ] && [ ! -s "$KEY_FILE" ]; then
  log "▸ API 키 발급 (평문은 발급 시점에만 존재한다)"
  mkdir -p "$(dirname "$KEY_FILE")"
  KEY=$(cd "$ROOT" && node scripts/seed-dev.mjs | sed -n 's/.*"apiKey": "\([^"]*\)".*/\1/p')
  [ -n "$KEY" ] || { echo "키 발급 실패" >&2; exit 1; }
  printf '%s\n' "$KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE" 2>/dev/null || true
fi
log "  키: $KEY_FILE"

# ---------- 4. API 서버 ----------
if [ "$START_SERVICES" = 1 ] && ! curl -sf -m 2 http://127.0.0.1:"${PORT:-8790}"/healthz >/dev/null 2>&1; then
  log "▸ API 서버 기동"
  # 세 디스크립터를 모두 끊는다.
  #
  # 왜 stdin 까지: 이 스크립트는 `eval "$(scripts/dev-up.sh --export-only)"` 형태로 쓰인다.
  # 명령 치환은 **상속된 파이프가 전부 닫힐 때까지 기다린다.** 백그라운드로 띄운 서버가
  # 그 파이프를 하나라도 물고 있으면 치환이 영원히 끝나지 않는다.
  # 실제로 그렇게 20분을 매달렸다 — 서버는 정상이었고 스크립트만 반환하지 못했다.
  # 서버가 이미 떠 있을 때는 이 분기를 타지 않아 몇 번이나 지나쳤다.
  # exec 로 서브셸의 디스크립터 자체를 먼저 갈아끼운다 — 자식이 파이프를 물려받을 길을 없앤다.
  ( cd "$ROOT" && exec >/tmp/aios-api.log 2>&1 </dev/null; nohup pnpm --filter @aios/api dev & )
  for _ in $(seq 1 90); do
    curl -sf -m 2 http://127.0.0.1:"${PORT:-8790}"/healthz >/dev/null 2>&1 && break; sleep 1
  done
fi
curl -sf -m 3 http://127.0.0.1:"${PORT:-8790}"/healthz >/dev/null 2>&1 || {
  if [ "$START_SERVICES" = 0 ]; then
    echo "API 서버가 떠 있지 않다 — 먼저 scripts/dev-up.sh 를 (인자 없이) 실행하라" >&2
  else
    echo "API 서버가 뜨지 않았다 — /tmp/aios-api.log 확인" >&2
  fi
  exit 1
}
log "  api: http://127.0.0.1:${PORT:-8790}"

# 검증 하네스가 요구하는 환경을 그대로 내보낸다.
if [ "$EXPORT_ONLY" = "--export-only" ]; then
  echo "export AIOS_BASE_URL=http://127.0.0.1:${PORT:-8790}"
  echo "export AIOS_API_KEY=$(cat "$KEY_FILE")"
else
  echo "AIOS 준비 완료: http://127.0.0.1:${PORT:-8790}"
fi
