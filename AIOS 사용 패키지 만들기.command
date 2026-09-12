#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "T7에 재설치용 소스 패키지를 만듭니다. 비밀 설정·DB·모델·의존성은 포함하지 않습니다."
node scripts/package-local.mjs "$@"
code=$?
if [[ -t 0 ]]; then read -r -p "확인 후 Enter를 누르면 창을 닫습니다. " _; fi
exit "$code"
