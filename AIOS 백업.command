#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "앱을 먼저 정상 종료해 주세요. DB·작업 파일·복구 기록을 T7에 통합 백업합니다."
node scripts/local-backup.mjs backup "$@"
code=$?
if [[ -t 0 ]]; then read -r -p "확인 후 Enter를 누르면 창을 닫습니다. " _; fi
exit "$code"
