#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "앱을 먼저 정상 종료해 주세요. 최신 백업을 새 DB·새 폴더에 복원 검사합니다. 기존 데이터는 교체하지 않습니다."
node scripts/local-backup.mjs restore-check "$@"
code=$?
if [[ -t 0 ]]; then read -r -p "확인 후 Enter를 누르면 창을 닫습니다. " _; fi
exit "$code"
