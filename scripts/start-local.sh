#!/bin/bash
# Finder와 터미널 모두 같은 감독 프로세스를 거쳐 중복 시작 잠금을 지킨다.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"
AIOS_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$AIOS_PROJECT_ROOT"
[ -d /Volumes/T7 ] || { echo "T7 외장 디스크를 연결한 뒤 다시 실행하세요."; exit 2; }
[ -f .env.local ] || { echo "설정 파일 .env.local이 없습니다. 기존 백업/설정을 확인하세요."; exit 2; }
command -v node >/dev/null || { echo "Node.js가 없습니다. Node 22와 프로젝트 의존성이 필요합니다."; exit 2; }
set -a
. ./.env.local
set +a
export PORT="${AIOS_LOCAL_PORT:-8791}" HOST=127.0.0.1 LOCAL_NO_AUTH=1 NODE_ENV=development
export PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
export LOCAL_WORKSPACE_ROOT="/Volumes/T7/bigdata/workspaces/my-first-project"
export OPENAI_API_KEY= ANTHROPIC_API_KEY= GEMINI_API_KEY= XAI_API_KEY=
export LOCAL_LLM_PROTOCOL=ollama LOCAL_LLM_CONTEXT="${AIOS_LOCAL_CONTEXT:-8192}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-/Volumes/T7/bigdata/ollama-models}"
exec node "$AIOS_PROJECT_ROOT/scripts/local-lifecycle.mjs" start "$@"
