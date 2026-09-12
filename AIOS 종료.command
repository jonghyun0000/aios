#!/bin/bash
cd "$(dirname "$0")" || exit 2
bash scripts/stop-local.sh "$@"
result=$?
if [ -t 0 ]; then
  echo "Enter를 누르면 닫습니다."
  read -r _answer
fi
exit "$result"
