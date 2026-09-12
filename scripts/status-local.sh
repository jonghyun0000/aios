#!/bin/bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"
AIOS_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "Node.js가 없습니다. Node 22와 프로젝트 의존성이 필요합니다. 자동 설치하지 않았습니다."; exit 2; }
exec node "$AIOS_PROJECT_ROOT/scripts/local-lifecycle.mjs" status "$@"
