# AGENTS.md — 에이전트용 진입점

**먼저 [HANDOFF.md](HANDOFF.md) 를 끝까지 읽어라.** 현재 상태·기동 방법·다음 할 일·함정이 모두 거기 있다.
이 저장소는 `main` 브랜치의 Git 프로젝트다. 2026-09-12 이전 단계는 커밋 이력이 없으므로 당시 근거는 HANDOFF와 `docs/`를 함께 확인한다.

## 절대 규칙
- 사용자와는 **한국어**로 소통한다.
- **실행으로 검증한다.** PASS 는 실제 실행 결과로만. 새 테스트는 결함 주입으로 검출력을 확인한다.
- 로컬 LLM 처럼 비결정적인 대상은 **1회 실행으로 결론 내지 않는다** — `apps/verify` 의 eval 을 쓴다.
- **모든 산출물은 `/Volumes/T7` 에만.** 맥 내장 디스크에 데이터·모델·캐시를 두지 않는다.
- 공개 GitHub 저장소다. API 키를 URL·로그·문서·커밋에 넣지 않는다. `.env*`(예제 제외), 사용자 DB·파일·백업·모델·`._*`는 추적하지 않는다.
- push 전 staged 파일 범위와 비밀 포함 여부를 확인한다. 기존 사용자 변경을 함께 커밋하지 않는다.
- 되돌리기 어려운 작업(볼륨·컨테이너 삭제, 외부 전송)은 사용자에게 먼저 확인한다.

## 자주 쓰는 명령
```bash
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"
colima start                                   # 재부팅 후
./scripts/dev-up.sh                            # 전체 기동 (10초)
eval "$(./scripts/dev-up.sh --export-only)"; set -a; . ./.env.local; set +a
node scripts/verify-all.mjs typecheck lint unit build   # 최소 검증
node scripts/verify-all.mjs                    # 전체 21단계 (15~40분)
cd apps/verify && REPEATS=5 pnpm eval          # 품질 측정
```
