#!/bin/bash
# Finder 더블클릭과 터미널 실행에서 같은 시작 경로를 사용한다.
cd "$(dirname "$0")" || exit 1
bash scripts/start-local.sh "$@"
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ]; then
  echo "시작하지 못했습니다. 위 안내를 확인하세요. Enter를 누르면 닫습니다."
  read -r _answer
fi
exit "$result"
