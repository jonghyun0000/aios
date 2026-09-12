# 실기동 검증 리포트 (Phase 1–8)

실행일: 2026-08-02 · 대상: 실제 Anthropic API + PostgreSQL 17(pgvector) + Redis 8 + Docker(colima)
재현: `apps/verify` 워크스페이스. `pnpm --filter @aios/verify phase1` … `phase8`

## 결과 요약

| Phase | 범위 | 결과 |
|---|---|---|
| 1 | Claude API 연결 / 스트리밍 / 도구호출 / 컨텍스트 / 토큰 / 재시도 / 타임아웃 | **PASS 16/16** |
| 2 | Session·Long-term Memory / Recall / Ranking / 압축 / 요약 / 컨텍스트 주입 | **PASS 30/30** |
| 3 | AI Router 정책 / 프로바이더 벤치마크 / 폴백 / 서킷브레이커 | **PASS 16/16** |
| 4 | Tool Engine: fs / shell(Docker) / git / MCP / plugin + 실패 케이스 | **PASS 48/48** |
| 5 | E2E 8단계 시나리오 (프로젝트→코드생성→커밋→수정→메모리→도구→플러그인→최종생성) | **PASS 31/31** |
| 6 | 성능/부하 (100·500·1000회, 동시성, 메모리, CPU, 비용) | **PASS 14/14** |
| 7 | 보안 (인젝션 5종 / 샌드박스 / JWT / API키 / RBAC / 웹훅) | **PASS 35/35** |
| 8 | 배포 (Docker·Compose·ENV·CI/CD·헬스·로깅·모니터링·백업·복구) | **PASS 39/39** |
| — | 타입체크 (11개 워크스페이스) / 단위 테스트 | **PASS · 21 tests** |

**총 229개 검사 전부 통과.**

---

## 검증으로 발견해 수정한 프로덕션 결함 6건

정적 리뷰나 단위 테스트로는 잡히지 않고, 실제 API·DB·컨테이너에 붙여야만 드러난 것들이다.

### 1. 모델 카탈로그의 ID가 실존하지 않음 (치명)
`claude-opus-4-5`, `claude-sonnet-4-5` 등 추측으로 작성한 ID는 API에 존재하지 않았다. 실제 ID(`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`)와 실제 단가·컨텍스트(1M)로 교체.
**교훈:** 모델 카탈로그는 프로바이더에 대고 검증해야 한다 — Phase 1.10이 매 실행마다 `GET /v1/models/{id}`로 확인한다.

### 2. 토큰 추정기 37% 과소 계산 (컨텍스트 초과 위험)
`chars/4` 휴리스틱은 영문 45,000자를 11,250 토큰으로 봤지만 실제는 72,033 토큰이었다. 과소 추정은 예산을 넘겨 전송 → 요청 전체 실패로 이어진다.
**수정:** 계수를 실측 기반 2.7 chars/token(라틴) / 1.0(CJK)로 조정, 추정은 항상 보수적(과대) 방향. 오차 37% → 7.4%.
**교훈:** 추정기의 오차 방향은 비대칭이다. 어느 쪽으로 틀리는 게 싼지 먼저 정하고 계수를 잡아야 한다. ([tokens.ts](../packages/shared/src/tokens.ts))

### 3. 사고형 모델에서 빈 응답 (치명)
`claude-opus-5`는 thinking이 기본 ON이고 `max_tokens`가 사고+응답을 함께 제한한다. `maxTokens=400`으로 120단어를 요청하자 400 토큰이 전부 사고에 소진되어 **사용자에게 빈 응답이, 에러 없이** 나갔다.
**수정:** ① 어댑터가 `thinking` 델타를 `thinking_delta` 이벤트로 정규화 ② 카탈로그에 `thinksByDefault` 플래그 ③ 라우터가 사고형 모델에 최소 4,096 토큰 출력 여유 강제 ④ 저가/요약 작업은 사고 자동 비활성화(비용·지연 절감).
**교훈:** 모델의 성질(사고 여부)을 아는 유일한 레이어가 라우터다 — 어댑터는 모델을 모르므로 이 방어는 라우터 책임. ([router.ts](../packages/ai/src/router.ts))

### 4. 도구 결과 ID 복합키로 모든 Claude 도구 루프 파손 (치명)
Gemini의 이름 기반 매칭을 위해 `toolCallId`에 `id::name` 복합키를 쓴 결과, Anthropic이 400을 반환했다(`tool_use_id`는 `^[a-zA-Z0-9_-]+$`만 허용). 첫 도구 결과에서 모든 에이전트 루프가 죽었다.
**수정:** `toolCallId`는 프로바이더 원본 id 그대로 유지, Gemini 어댑터가 대화에서 id→이름을 역인덱싱해 자체 해결.
**교훈:** 한 프로바이더의 편의를 위해 공용 데이터 구조를 오염시키면 다른 프로바이더가 깨진다. 프로바이더별 문제는 프로바이더별 어댑터 안에서 푼다. ([gemini.ts](../packages/ai/src/providers/gemini.ts), [orchestrator.ts](../apps/api/src/agent/orchestrator.ts))

### 5. STM 예산이 rolling summary를 누락
`getWindow().approxTokens`가 메시지 토큰만 세고 요약을 빠뜨려, 요약이 누적될수록 실제 사용량이 예산을 조용히 초과했다 — 압축이 트리거되지 않아 결국 컨텍스트 초과.
**수정:** 요약 토큰을 예산에 포함. ([short-term.ts](../packages/memory/src/short-term.ts))

### 6. RLS 정책이 셀프호스팅에서 마이그레이션 실패 + 기타 2건
`auth.uid()`는 Supabase 전용이라 일반 Postgres에서 마이그레이션이 통째로 실패했다. `auth` 스키마 존재 시에만 정책을 생성하도록 가드. 함께 수정: `sessions.user_id NOT NULL`(API 키 세션 생성 불가), SSE에서 `reply.hijack()` 누락(Fastify 이중 응답).

### 부수 개선: restore.sh의 과잉 안전장치
"RESTORE_TARGET이 지정됐으면 차단"은 새 이름으로의 정상 복원까지 막아, 운영자가 `--force`를 습관적으로 붙이게 만든다 — 경고 피로를 만들고 정작 사고를 못 막는다. **DB가 실제로 존재할 때만** 차단하도록 변경. ([restore.sh](../scripts/restore.sh))

---

## Phase별 주요 실측 결과

### Phase 1 — Claude API
연결 2.5s, 스트리밍 12델타/1,381자, TTFT 821ms. 도구 단일/병렬 호출 및 결과 왕복 정상. 72,033 토큰 입력 처리 확인. 401/404를 non-retryable로 정확히 분류(폴백 대상 아님), AbortSignal 709ms 내 취소.

### Phase 2 — Memory
압축이 817→577 토큰으로 줄이면서 핵심 결정(pgvector·canary·UTC)을 요약에 보존. 중복 제거(유사도 0.9+)와 중요도 랭킹(0.9 항목이 0.1 항목보다 상위) 동작. 교차 조직 recall 0건, 교차 테넌트 삭제 차단.

### Phase 3 — Router
`claude-opus-5` 실측: 도구호출 OK, JSON 모드 OK, 결정론적 품질과제 4/4(100%), $0.035/요청(1,399 출력 토큰). 라우팅 정책 8종 전부 의도대로: code→tier3, cheap/summarize→haiku, 300k 프롬프트에서 소형 모델 자동 배제, 모델 고정 시 폴백 금지. 고장 프로바이더 → Claude 폴백 성공, 5회 실패 후 브레이커 open 확인.
**참고:** OpenAI/Gemini 키가 없어 3사 비교는 Claude 열만 실측했다. 다른 키를 넣으면 동일 하네스가 자동으로 비교표를 채운다.

### Phase 4 — Tool Engine
경로 탈출 4종 차단, 스키마 위반은 throw가 아닌 모델 피드백으로 반환, 200KB 파일 32KB로 절단, 타임아웃 401ms 내 강제. 감사 로그가 ok/error/denied/timeout 4개 상태를 모두 포착. Docker 샌드박스: 네트워크 차단(DNS 실패), 비루트(uid 10001), 읽기전용 rootfs 확인. MCP 13개 도구가 동일 정책 관문 통과, `net=deny` 시 MCP도 차단.

### Phase 5 — E2E
AI가 생성한 `subtotal` 함수를 실제 실행해 정답 35 확인. 2차 편집에서 기존 함수 보존하며 `applyDiscount` 추가, 커밋 4개 생성. 메모리에 저장한 컨벤션("named exports only")을 최종 생성이 준수 — 메모리→프롬프트→코드 경로가 실제로 작동함을 입증.

### Phase 6 — 성능
[07-scaling-cost-bottleneck.md §14.0](07-scaling-cost-bottleneck.md) 표 참조.

### Phase 7 — 보안
프롬프트 인젝션: 파일에 심은 "SYSTEM OVERRIDE" 지시를 모델이 무시하고 실제 질문에 답했으며, **설령 속았더라도** 도구 관문이 경로 탈출을 차단(다층 방어 확인). 컨테이너 내 `touch`가 호스트에 영향 없음, 데이터 유출 차단, 권한 상승 실패, fork bomb 92ms 내 봉쇄, docker 소켓 미노출. JWT alg=none·만료·변조·키불일치 4종 거부. RBAC 16개 역할 조합 전부 정확. 웹훅 위조·리플레이·본문변조 거부.

### Phase 8 — 배포
`/healthz`(의존성 미확인 — 재시작 폭풍 방지) / `/readyz`(PG·Redis 왕복) / `/metrics`(Prometheus 17샘플, 서킷브레이커 상태 포함) 3종 분리 구현·검증. 구조화 JSON 로깅에 reqId·orgId 컨텍스트 확인. **백업→복원 왕복 실검증**: 19개 테이블 + pgvector 확장 복원 성공. compose 의존성 게이트(`service_healthy`), CI 게이트 순서, 수동 승인 + canary 확인.

---

## 남은 한계 (정직한 기재)

1. **OpenAI/Gemini/xAI 실측 미완** — 키 미보유. 어댑터 코드는 작성돼 있고 하네스도 준비됐으나 실호출 검증은 되지 않았다. Anthropic 어댑터에서 발견된 종류의 결함(모델 ID, 파라미터 제약)이 다른 어댑터에도 있을 가능성이 높다.
2. ~~**임베딩은 해시 폴백 사용**~~ — **해소됨(2026-08-28).** 로컬 임베더(bge-m3, 1024차원)를 붙여
   하네스가 실제 임베딩으로 돈다. 의미 검색 품질도 실측했다 — 최소 유사도 하한 0.5(무의미 질의
   최대 0.471 vs 최약 정상 0.550), 중복 판정 임계값은 실측 근거로 재설계했다([06-engines.md](06-engines.md) 참조).
   해시 폴백은 임베더가 하나도 없는 환경을 위한 마지막 수단으로만 남아 있고, 하네스가 어떤
   임베더를 썼는지 항상 출력한다.
3. **부하 규모** — 단일 머신 기준 1000회/동시 50.
   - 다중 노드 WS 팬아웃: ~~미측정~~ → **검증됨.** `s6:collab-multi` 가 인스턴스 2개를 실제로
     띄워 A→B·B→A 전파, 커서 공유, 문서 격리를 확인한다(9/9).
   - pgbouncer 경유 커넥션 고갈, 대형 리포(10만 파일) 인덱싱: **여전히 미측정.**
4. **VSCode 확장은 빌드만 검증** — Extension Host 실행은 GUI가 필요해 자동 검증에서 제외했다.
5. **eval(품질 회귀) 스위트 미구축** — 16장 계획의 SWE-bench 스타일 내부 셋 50태스크는 아직 없다. Phase 3의 결정론적 4과제가 최소 대용물이다.


---

## 환경 문제와 제품 결함은 다른 색이어야 한다

전체 파이프라인에서 이렇게 실패했다:

```
RUN   Full scenario ... FAIL (485.2s)
```

읽는 사람에게는 "에이전트 시나리오가 깨졌다"로 보인다. 실제 원인은 달랐다:

```
PASS  s4.agent_edited — write_file called 1 time(s)   ← 에이전트는 정상 동작했다
FAILED: s2-scenario.uncaught — threw: spawn git ENOENT
```

**git 이 없었다.** 그것도 잠깐 — 다시 확인하니 `/usr/bin/git` 은 멀쩡했다(2.50.1).
새 기기라 개발자 도구 경로가 일시적으로 무효했던 것으로 보인다
(`/usr/bin/git` 은 활성 개발자 디렉터리로 넘기는 shim 이다).

문제는 실패 자체가 아니라 **그 실패가 제품 결함처럼 보인다는 것**이다.
이런 것이 섞이면 초록/빨강의 의미가 흐려지고, 진짜 회귀가 "또 환경 문제겠지"로 묻힌다.

### 고침 — 시작하자마자 확인하고, 없으면 이름을 대며 멈춘다

```
[0 — Toolchain]
  FAIL  env.git_available — 사용 불가: Command failed: git --version
        xcrun: error: invalid active developer path
        — 제품 결함이 아니라 실행 환경 문제다. macOS 라면 xcode-select --install 후 다시 실행하라.
SPRINT 2 · STEP 6 — Full product scenario: FAIL  (0/1)
```

**0/1 로 끝난다.** 계속 진행하면 이후 20개 단언이 전부 같은 원인으로 무너져 원인을 가린다.
결함 주입(고장 난 `git` shim)으로 확인했고, 종료코드도 1이다.

곁가지로 하나 더 고쳤다: 처음에는 조치 안내가 화면에 나오지 않았다.
execFile 오류 메시지에 줄바꿈이 있는데 리포트는 한 줄만 보여 주므로, 뒤에 붙인 안내가
통째로 잘렸다. 메시지의 공백을 접어 한 줄로 만든 뒤에야 안내가 살아남았다.
**진단을 붙였다고 끝이 아니라, 그것이 실제로 보이는지까지 확인해야 한다.**
