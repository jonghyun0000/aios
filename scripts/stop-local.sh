#!/bin/bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"
AIOS_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "Node.js가 없어 소유권을 안전하게 확인할 수 없습니다. 임의로 프로세스를 종료하지 않습니다."; exit 2; }
exec node "$AIOS_PROJECT_ROOT/scripts/local-lifecycle.mjs" stop "$@"
