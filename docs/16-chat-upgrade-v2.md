# 채팅 2차 업그레이드 — 2026-09-12

사용자 요청: Enter 전송, 느린 응답 개선, 대화 내역을 왼쪽 사이드바에 통합.
외부 프로바이더나 새 모델 없이 기존 Mac M4 16GB + T7 + qwen3:8b에서 개선했다.

현재 기본 자동 선택·정확 계산·시간 계측과 최신 결과는 `17-stage1-auto-response.md`를 참고한다. 아래는 2차 당시의 기록이다.

## 바뀐 동작

- Enter 전송 / Shift+Enter 줄바꿈. 기존 Ctrl·⌘+Enter도 지원하며 한글 IME 조합과 Safari keyCode 229는 제외한다.
- 대화 내역은 왼쪽 내비게이션에 한 번만 표시한다. 최근 대화·이전 대화 더 보기·활성 표시·새 대화를 제공한다.
- 모바일은 상단 메뉴의 ‘대화 내역’ 펼치기로 통합한다. 새 대화는 첫 전송 시 저장하며 입력창은 화면 하단에 유지한다.
- 기본 ‘빠른 응답’: 추론과 임베딩 기반 장기기억 검색·백그라운드 사실 추출을 생략한다. 현재 대화의 메시지와 요약은 유지한다.
- ‘깊이 생각’: 기존 추론과 장기기억을 사용한다. 계산·복잡한 코드는 이 모드를 권장하며 어느 모드도 정답을 보장하지 않는다.
- 경과 시간·중단·전송 후 입력창 포커스 복귀를 제공한다. 저장본 재조회 실패 시 받은 답을 보존하며 재조회 대기는 12초로 제한한다.
- 메시지 저장 시 `updated_at`을 갱신해 이어 쓴 대화가 목록 위로 올라온다.
- 완료 메모리 잡이 고정 ID를 영구 점유하던 문제를 수정했다. 대기 중 빠른 모드에서 깊이 생각으로 바뀌면 추출 요청을 합친다.

기존 LocalAdapter는 `reasoning: off`를 실제 전송 JSON으로 옮기지 않았다.
Ollama 호환 API의 `reasoning_effort: none`으로 전달하도록 고쳤으며 클라우드 어댑터 요청은 변경하지 않았다.
근거: [Ollama 공식 호환 API](https://docs.ollama.com/api/openai-compatibility).

## 실제 반복 측정

`apps/verify/src/eval/chat-latency.ts`로 웹과 같은 세션 생성 → POST 메시지 → SSE → 저장 경로를 측정했다.
각 조건 3회, 단일 사용자·이미 실행 중인 로컬 모델에서 기존 기본 요청과 새 빠른 요청을 비교했다.

| 질문 | 기존 첫 글자 중앙값 | 빠른 첫 글자 중앙값 | 기존 완료 중앙값 | 빠른 완료 중앙값 |
|---|---:|---:|---:|---:|
| 17+25, 숫자만 | 13.949초 | 0.117초 | 14.094초 | 0.290초 |
| 오늘 할 일 정리, 한국어 3문장 | 13.761초 | 0.080초 | 20.572초 | 5.003초 |

프롬프트 캐시·모델 상주 효과가 포함된다. 첫 모델 로딩·동시 사용·다른 프로그램 부하·긴 대화·도구 작업에서는 달라진다.
한국어 첫 기존 측정 중 정적 검사가 일부 겹쳤다. 이 표본으로 모든 작업의 같은 배속이나 통계적 유의성을 주장하지 않는다.
별도 3세션에서 프로젝트 이름을 알려준 다음 다시 묻는 2턴 맥락 검사도 **3/3** 통과했다.
결과 JSON: `/Volumes/T7/bigdata/eval-baselines/chat-v2-*.json`.

## 검증과 한계

- 타입 검사·린트·단위 검사·빌드: PASS.
- 최종 빌드로 시작기를 재실행하여 DB/Redis 준비 상태를 확인했다. 실제 화면에서 Enter 전송과 새 대화의 사이드바 반영·한국어 스트리밍 응답을 확인했다.
- 전체 브라우저: **65 PASS / 0 FAIL / 3 SKIP** (68개). 3개는 데스크톱에서 제외한 모바일 전용 검사이며 모바일에서는 통과했다.
- 신규 브라우저 검사: Enter·줄바꿈·IME·모드·사이드바·페이지 추가·모바일 배치·목록/기록 재조회 오류.
- 결함 주입: HTTP 503·지연 응답·IME 보호 제거·reasoning 필드 유실·장기기억 플래그 유실·완료 큐 항목 잔존.
- `EVAL_REASONING=off REPEATS=3`으로 기존 13개 과제 39회 실행: **36/39**, 95% CI 80~97%.
  도구 9/9, 형식 9/9, 한국어 6/6, 코드 6/6, 정밀도 6/9.
  **2026-09-12 정정:** 실제 빠른 모드 과제는 `17 * 23 + 41`(정답 432)이었으며 3회 모두 `403`을 냈다.
  깊이 생각 API 재검사는 서로 다른 문제 `17 * 23`(정답 391)로 3/3이었다.
  따라서 종전의 “같은 문제를 깊이 생각으로 해결했다”는 비교 주장은 철회한다.
  보고서: `qwen3-fast-v2.json`, `chat-v2-arithmetic-thorough.json` (위 eval-baselines 폴더).

기존 2026-09-11 추론 기본 모드 65/65 기준선과 설정·표본 수가 다르다. 빠른 모드가 같은 품질이라고 주장하지 않는다.
과거 21단계 전체 검증을 이번 변경으로 다시 실행한 것은 아니다. 외부 계정·클라우드·대규모 프로젝트는 범위 밖이다.

## 재현

사용자 시작기로 서버를 실행한 뒤 프로젝트 루트에서 검사한다. 브라우저 검사는 빌드 완료 후, 벤치마크는 한 번에 하나씩 실행한다.

```bash
node scripts/verify-all.mjs typecheck lint unit build
AIOS_BASE_URL=http://127.0.0.1:8791 PLAYWRIGHT_BROWSERS_PATH=/Volumes/T7/bigdata/playwright-browsers pnpm --filter @aios/web test:e2e
cd apps/verify
CHAT_SCENARIO=guide CHAT_MODE=legacy pnpm exec tsx src/eval/chat-latency.ts
CHAT_SCENARIO=guide CHAT_MODE=fast pnpm exec tsx src/eval/chat-latency.ts
CHAT_SCENARIO=context CHAT_MODE=fast pnpm exec tsx src/eval/chat-latency.ts
CHAT_SCENARIO=arithmetic CHAT_MODE=thorough pnpm exec tsx src/eval/chat-latency.ts
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1 LOCAL_LLM_MODELS=qwen3:8b EVAL_REASONING=off REPEATS=3 pnpm eval --save qwen3-fast-v2
```
