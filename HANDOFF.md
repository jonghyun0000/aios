# HANDOFF — 이 문서만 읽고 이어서 작업할 수 있게

> 작성: 2026-09-12 · 최근 담당: Codex · **Git main 브랜치로 전환** —
> 그 이전 단계에는 커밋 이력이 없다. 이후 커밋 이력과 이 문서·`docs/`를 함께 확인하고 작업을 끝낼 때 갱신한다.

---

## 0. 30초 요약

- **현재 제품:** AIOS 로컬 AI 작업공간. 사용자 시작기는 `AIOS 시작.command` → `http://127.0.0.1:8791`이며, 개발용 8790과 구분한다(§3).
- **다음 작업:** [NEXT_STEPS.md](NEXT_STEPS.md)의 **2-1 Linux CI 통합 잡** 진행 중. `ddf1c73` 원격 audit·verify 성공, integration은 구버전 Ollama 대화 HTTP 400으로 실패했다. CI 버전을 로컬 검증 버전으로 정렬했으며 재push 승인 후 원격 확인이 필요하다(`docs/37`). 긴 과거 이력은 [CHANGELOG.md](CHANGELOG.md)에 보존했다.
- **Claude 변경(2026-09-19):** Fastify 5·관련 플러그인과 감사 게이트(`b9f12d9`), 인계 가이드(`174e2dc`). 의존성 감사 15→0, 정적4·단위464·실서버7·보안·브라우저123/3skip은 그 커밋의 기록이다(`docs/08` §15.5).
- **이번 후속 작업 완료:** 운영 이미지 Node/pnpm 정렬·컨텍스트 보호. 실제 격리 기동/인증/종료, 정적4·단위464·추가회귀10 통과. 인계 원문101줄 보존 확인. 범위·경고·실패 기록은 [docs/30-container-build.md](docs/30-container-build.md).
- **1-2 완료(2026-09-22):** 하네스 임시 작업공간을 실경로로 통일하고 정확한 경로만 정리한다. 결함 주입 검출, phase4 48/48, phase7 36/36×3, phase6 16/16, s2 시나리오 23/23, 정적4·단위465 PASS. 근거 `docs/32`.
- **1-3 완료(2026-09-22):** 실제 TCP 이탈만 debug로 분류하고 HTTP path-param 전체 감사에서 UUID DB 경로 5개를 모두 DB 전에 400으로 거부한다. 결함 주입 3종, 실제 PG 전후, 관련83/83, 정적4·단위473 PASS. 근거 `docs/33`, 구현 `3a02beb`·`6107a70`.
- **1-4 완료(2026-09-22):** Browser E2E는 공개·읽기 전용 인증 capability로 `LOCAL_NO_AUTH=1` 서버만 실행한다. 키 인증·판별 불가·잘못된 URL은 자식 전에 BLOCKED/INCOMPLETE. 결함 주입, 오케스트레이터15/15, 정적4·단위475 PASS. 실제 Chromium은 미실행. 근거 `docs/34`, 구현 `9107f28`.
- **1-5·단계1 완료(2026-09-22):** pnpm이 PATH에 없으면 사용자 상태나 서비스를 건드리기 전에 직접 원인·AGENTS PATH·확인 명령을 내고 종료한다. 결함 주입 1건 검출, 표적3/3·local-ops1/1·정적4·단위475 PASS. 실제 정상 전체 기동은 미실행. 근거 `docs/35`, 구현 `c8b635e`.
- **남은 P0:** 없음. 다음은 두 번째 Mac 없이 새 환경 재현성을 만드는 단계2다.
- **공개 상태:** GitHub `jonghyun0000/aios`; 자체 소스·문서는 MIT(`76c10a2`, `docs/36`). 체험판 `https://aios-demo-mu.vercel.app`은 가상 응답/파일만 쓰며 push가 재배포하지 않는다.
- **공개 반영(2026-09-22):** 사용자 승인으로 `5de9544`까지 push했고 [원격 CI audit·verify](https://github.com/jonghyun0000/aios/actions/runs/35723839403)가 성공했다. Vercel 재배포는 미실행이다.
- **현재 기동 정상(2026-09-20):** 사용자 승인 후 Colima 정상 재시작으로 T7 공유 오류 복구. 사용자 시작기로 API·워커 ready, 통계 화면4검사·채팅 응답/저장3회 확인. 신규 자료 적재는 별도이며 [docs/31](docs/31-bigdata-connection.md)에 기록했다.
- **점수:** 기존 90/100은 당시 AI 자체 평가(`docs/22`). 별도 약70±6 의견과 근거 한계는 NEXT_STEPS §1에 있다. 이번 작업으로 점수를 올리지 않는다.
- **전제 변경:** M1 Air 판매로 두 번째 Mac이 없다. 다른 Mac 설치 근거는 미충족으로 두고 같은 Mac/CI 결과로 대체 가산하지 않는다.
- **안전 경계:** 사용자 DB·작업 파일·설정 보존. phase8/legacy-full/운영 복원·과거 볼륨 삭제 금지. 새 시험 자원만 정확한 ID로 정리한다.
- **환경 함정:** T7·pnpm PATH·Xcode 라이선스가 막힌 기본 git·TMPDIR·e2e의 `LOCAL_NO_AUTH=1` 전제는 NEXT_STEPS §3.1과 아래 §8을 따른다.

---

## 1. 사용자와 작업 규칙 — 반드시 지킬 것

사용자는 한국어로 소통한다. 아래는 이 프로젝트 내내 유지된 규칙이다.

1. **설명만 하지 말고 실행으로 검증한다.** PASS 는 실제 실행 결과로만 쓴다. 추정·예상은 PASS 가 아니다.
2. **통과했다고 검증된 것은 아니다.** 새 테스트는 **결함 주입으로 실제로 잡는지** 확인한다.
   이 저장소에서 초록인데 아무것도 검증하지 않던 테스트가 여러 번 나왔다(§8).
3. **비결정적 대상(로컬 LLM)은 1회 실행으로 결론 내지 않는다.** eval 로 반복·신뢰구간을 본다(§5).
   실제로 1회 통과를 보고 "효과 있다"고 썼다가 뒤집힌 적이 있다.
4. **모든 산출물은 T7 외장 디스크에만 저장한다. 맥 내장 디스크에는 두지 않는다.**
   (데이터셋·모델·캐시·백업·키 전부. 예외는 APFS 가 꼭 필요한 임시 파일뿐 — §8)
5. **API 키를 URL 에 넣지 않는다**(브라우저 기록·리퍼러·접근 로그에 남는다). 키 값을 출력·커밋·문서화하지 않는다.
6. 설계 결정마다 **왜** 그렇게 했는지 코드 주석과 `docs/` 에 남긴다. 주석은 한국어, "무엇"보다 "왜".
7. 되돌리기 어렵거나 외부로 나가는 작업(컨테이너·볼륨 삭제, 결제, 외부 전송)은 **사용자에게 먼저 확인**한다.
8. 틀린 기록을 발견하면 조용히 고치지 말고 **정정했다고 문서에 남긴다.** 근거 없는 주장은 철회한다.

---

## 2. 환경

| 항목 | 값 |
|---|---|
| 기기 | MacBook Pro, Apple M4 10코어, 16GB (이전 측정 일부는 MacBook Air) |
| 저장소 | `/Volumes/T7/클로드 코드 T7/클로드 대형 프로젝트/난제1(AI운영체제)` — **경로에 공백·한글** |
| T7 | Samsung T7 1TB, **exFAT(fskit)**, USB. 여유 약 527GB |
| Node | 22.18.0 · 패키지 매니저 pnpm 9.12.0 (corepack) |
| Docker | colima (VM 디스크는 맥에 있다) |
| 원본 데이터 | 사용자 홈의 `Desktop/프로젝트 폴더/빅데이터 창구/` (4.9GB, 읽기 전용으로 쓴다; GitHub에는 미포함) |

**T7 연결 속도를 먼저 확인하라.** USB 2.0 케이블로 붙으면 25배 느려지고 모든 성능 수치가 오염된다.
```bash
ioreg -p IOUSB -w0 -l | grep -A3 "PSSD T7" | grep "Device Speed"   # 4 = 10Gbps 정상, 2 = USB 2.0
```

**pnpm 이 PATH 에 없을 수 있다.** 셸 시작 시:
```bash
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"
```

---

## 3. 기동 — 한 줄

**사용자용:** 프로젝트의 `AIOS 시작.command`. 별도 포트 8791에서 키 없는 로컬 전용 API와 워커를 실행한다.
`/Volumes/T7/bigdata/workspaces/my-first-project`만 작업 폴더로 사용한다. 종료는 `AIOS 종료.command` 또는 시작 터미널의 Ctrl+C, 현재 상태는 `AIOS 상태 확인.command`.
기동/유지보수 잠금과 종료 실패를 확인한다. `AIOS 백업.command`/`AIOS 복원 검사.command`는 앱 정상 종료 후 사용하며 DB·Redis·Ollama는 종료 시 유지된다.
Colima에 위 작업 폴더의 상위 `workspaces`를 공유하도록 설정했다(기존 홈 공유 유지).
시작기가 Docker에서 호스트 표식 파일을 실제로 읽을 수 있는지 검사한다. 개발용 아래 명령과 구분한다.

```bash
colima start                      # 재부팅 후 한 번
./scripts/dev-up.sh               # Postgres·Redis·Ollama·API 서버를 올리고 export 문을 출력
```

- 설정: 저장소 안 `.env.local` (gitignore 됨, T7 에 있으므로 기기가 바뀌어도 따라온다). 포트 **8790**.
  **이미 있으면 `.env.example` 로 덮어쓰지 말 것** — 작동 중인 설정(포트·T7 경로·동시성)이 날아간다.
- API 키(개발용): `/Volumes/T7/bigdata/secrets/aios-dev-key.txt` (0600). 없으면 `dev-up.sh` 가 발급한다.
  DB 에는 해시만 있으므로 **이 파일을 잃으면 되찾을 수 없다 — 재발급만 가능하다.**
- Ollama 모델은 `/Volumes/T7/bigdata/ollama-models` (19GB). `OLLAMA_MODELS` 없이 띄우면 맥에 새로 받는다 — 스크립트가 막는다.
- `dev-up.sh --export-only` 는 **아무것도 기동하지 않고** 환경만 출력한다(서비스가 없으면 오류).
  `eval "$(./scripts/dev-up.sh --export-only)"` 형태로 쓴다. 이유는 §8 "명령 치환".

검증·eval 을 돌리기 전에:
```bash
eval "$(./scripts/dev-up.sh --export-only)"; set -a; . ./.env.local; set +a
```

---

## 4. 검증 — `node scripts/verify-all.mjs [단계...]`

인자 없이 돌리면 `typecheck lint unit build`의 정적 4단계만 실행한다. 로컬 운영 회귀는 `typecheck lint unit local-ops build --report`를 사용한다. 오타/중복 단계는 실행 전에 거부하며, SKIP·차단·검사 0개는 PASS가 아니다. 검사 중 코드 지문이 바뀌면 현재 버전의 통과로 사용할 수 없다. 상세 `docs/28-release-verification.md`.
구형 전체 실행은 `--legacy-full --allow-destructive-phase8`을 모두 명시해야 한다. phase8은 파괴적 정리/롤백을 포함하므로 이 옵션을 사용자 승인으로 해석하거나 운영 데이터에 실행하지 말 것. 로컬 복원 검사는 `local-backup.mjs restore-check`로 분리했다.
**출력을 `tail` 로 자르지 말고 파일로 남겨라** — 실패 원인이 앞부분에 있다.

| 단계 id | 내용 | 조건 | 최근 소요 |
|---|---|---|---|
| typecheck · lint · unit · build | 정적 검사 | — | 각 1~40s |
| local-ops | 로컬 시작/정지·백업·소스 패키지 결함 주입 | T7, 로컬 프로세스 검사 | 약 3s |
| durability-local | 새 DB와 폴더에서 승인·복구·다중 프로세스 소유권 | `AIOS_DURABILITY_TEST=1`, 로컬 `DATABASE_URL`(CREATEDB); 운영 DB 변경 없음 | 현재 실행 근거는 docs/26 |
| context-live | 실제 API·DB·Redis·모델의 고정 8과제×3회 | `AIOS_CONTEXT_PERSISTENCE_TEST=1`, 로컬 DB/Redis; 이 실행의 새 합성 대화만 생성·휴지통 이동 | 현재 실행 근거는 docs/25 |
| s2-claude | Claude 고유 동작 | `ANTHROPIC_API_KEY` 필요 → 없으면 SKIP | — |
| s2-memory | STM/LTM 부하·누수 | — | 30s |
| phase3 | 라우터 정책·폴백·서킷브레이커 | 프로바이더 1개 이상(로컬 포함) | 10~40s |
| phase4 | 도구 엔진·샌드박스 | Docker | 5s |
| s2-scenario | 전체 제품 시나리오(생성→결함→에이전트 수리→커밋→기억) | 프로바이더 | **4~20분** |
| s3-collab · marketplace · billing · oauth · webui | Sprint 3 기능 | 서버 | 각 1~3s |
| s4-bigdata · s5-bigdata-api | 데이터 계층 도구·HTTP | 서버(s5) | 1~5s |
| s6-collab-multi | 협업 인스턴스 2개 실제 기동 | 서버 | 3s |
| e2e | Playwright 126개 중123통과/3desktop 해당없음 (과거 실행, 데스크톱·모바일·합성 API 포함) | `LOCAL_NO_AUTH=1` 서버; `verify-all`이 사전 판별 | 약2.5분 |
| phase6 | 성능·부하(로컬 LLM 동시 12스트림 포함) | — | 5~15분 |
| phase7 | 보안(인젝션·샌드박스·RBAC·JWT) | — | 1~3분 |
| phase8 | 배포 준비(이미지 새로 빌드·백업/복구·SIGTERM·롤백) | Docker | 2~5분 |

- `verify-all` 은 **통과한 단언을 출력하지 않는다.** 상세는 `pnpm --filter @aios/verify <스크립트>` 로 직접.
- 서버 의존 단계 직전에 서버 생존을 확인하고, 죽어 있으면 `BLOCKED` 로 표시하며 크래시 리포트 위치를 알려 준다.
- `Full scenario` 는 **로컬 7B 의 비결정성 때문에 가끔 실패한다**(§7). 실패 메시지에 턴 수·게이트 개입 횟수·모델이 쓴 코드가 남는다.
- **CI 범위를 구분한다.** 공개 저장소의 `.github/workflows/ci.yml`은 Node 22 정적 검사·빌드·머신 독립 단위 검사, 정적 데모와 실제 앱의 합성 API/WS 접근성·키보드 회귀를 수행한다.
  추가한 `integration` 잡은 실제 서비스·마이그레이션·대화 3회·파일 승인·복구 경로를 검사한다. 최초 원격 실행은 대화 HTTP 400으로 실패했으며 버전 정렬 후 원격 결과는 미검증이다. 로컬 근거·한계는 `docs/37`을 따른다.
  T7/macOS 전용 시험·실제 모델·사용자 데이터 복원은 로컬에서 별도로 검증해야 한다. 과거 Git 추적 전에는 CI 실행 기록이 없었으며, 그때의 로컬 통과 기록이 원격 CI 통과를 뜻하지 않는다.

---

## 5. eval(품질 회귀) — `apps/verify/src/eval/`

모델·프롬프트를 바꿨을 때 **품질이 나빠졌는지** 재는 도구. 13과제 5범주(tool/format/korean/code/precision),
전부 이 저장소에서 실제로 깨졌던 능력이다. 채점은 결정론적(LLM-as-judge 없음), 코드 과제는 esbuild 로 트랜스파일해 `node:vm` 에서 실행.

```bash
cd apps/verify
REPEATS=5 pnpm eval                          # 측정 (최소 3회 반복, 1회 실행 불가)
REPEATS=5 pnpm eval --save <이름>            # 기준선 저장 → /Volumes/T7/bigdata/eval-baselines/<이름>.json
REPEATS=5 pnpm eval --against <이름>         # 기준선과 비교
```

- 결과는 항상 **Wilson 95% 신뢰구간**과 함께 나온다. 비교는 **구간이 겹치지 않을 때만** 개선/악화로 판정(보수적 — 일부러).
- **"구분 불가"는 "차이 없음"이 아니다.** 출력되는 "탐지 가능한 최소 개선"보다 작은 차이는 이 표본으로 알 수 없다.
- 단위 테스트 31개(`src/eval/__tests__/`) — 채점기가 정답을 떨어뜨리지 않는지까지 검증한다.
- 첫 실행(REPEATS=3): 전체 92%. 단 `code.even-sum` 0/3 은 **채점기 결함**이었다(정규식이 삼항 연산자를 지움).
  수정 후 실제 기준선 측정(REPEATS=5, 2026-09-11)은 모든 과제 5/5, 총 65/65 (100%)였다.

---

## 6. 다음 할 일

**순서·완료 기준·작업 방법은 [NEXT_STEPS.md](NEXT_STEPS.md) 로 옮겼다(2026-09-19).** 여기에 목록을 다시 적지 않는다. 두 곳에 두면 한쪽이 낡는다.

예전 이 절의 항목이 어디로 갔는지:

| 예전 항목 | NEXT_STEPS 위치 |
|---|---|
| 프롬프트 자기 검증 규칙 재판정(다중 턴 eval 필요) | 3-4 |
| eval 을 verify-all 에 넣을지 결정 | 3-1 의 결과를 보고 결정 |
| bigdata 격리 후 관찰(위험 14) | 단계 4 "계속 관찰" |
| 대형 리포 인덱싱 측정 | 3-5 |
| 실계정 검증(OAuth·Stripe·타 프로바이더) | 단계 4 |
| 별도 디스크 백업·운영본 복구·다른 Mac 이관 | 2-3, §2(다른 Mac 은 불가) |
| README·docs 는 작업마다 갱신 | §3.2 의 7번 |

단계별 구현 범위의 요약(1~4단계)은 `docs/17`~`docs/20` 과 §0 에 있다. 각 단계의 한계(단일 API, 읽기 전용 명령, 64 KiB, 호스트 동시 변경 등)는 §7 위험 21~28 로 유지한다.

---

## 7. 알려진 위험 (PASS 아님)

전체 목록과 근거는 `docs/final-verification-report.md` §7. 요약:

| # | 위험 | 상태 |
|---|---|---|
| 1 | OpenAI·Gemini·xAI 어댑터 실호출 0회 | 키 없음 |
| 6 | eval 스위트 | 기준선 저장 완료(로컬 qwen3:8b, 5회·65/65). 단일 모델·표본 5회의 한계는 남음 |
| 3·4 | pgbouncer 경유·대형 리포 인덱싱 부하 | 미측정 |
| 7·8·9 | VSCode 확장 실행·Linux 샌드박스·Stripe 실왕복 | 미검증 |
| 14 | **exFAT+fskit 위 네이티브 SIGBUS** | 별도 통계 프로세스로 격리 완료. 실제 자식 강제 종료 3회 API 생존·조회 복구 확인. 원인 자체는 미해결 |
| 15 | 완료 판정 게이트의 라이브 발동 | 결정론적 시험 16개로 규칙은 증명, 실행에서 켜지는 것은 미관측 |
| 16 | 프롬프트 자기 검증 규칙 | 효과 미입증(측정에서 기각) |
| 17 | 도구의 `.git` 접근 차단 | 단위 테스트만 |
| 18 | 로컬 7B 에이전트 신뢰도 | 확률적 — 무인 파이프라인은 재시도 전제 |
| 19 | 응답 정책의 정밀도 | 최신 50문제×3회: 빠른 127/150, 자동 148/150. 자동 계산 39/39이나 지정 언어 회상 오류 2건. 과거 깊이 생각의 동일 문제 해결 주장은 비교 오류로 철회 |
| 20 | 자동 분류·재적재 지연 | 규칙 기반이므로 의도 오분류 가능. API 모델 재적재 완료 중앙값 9.060초, 이전 실행에서 11.657초도 관측. 모든 질문의 속도·품질을 보장하지 않음 |
| 21 | 2단계 자료·회상 한도 | UTF-8 64KiB, 대화/프로젝트 각 8개·관련 구간 4개. DB 최근 메시지 100개에서 모델 예산으로 추가 절단. PDF/이미지/Word·디렉터리 동기화·무제한 회상 미구현 |
| 22 | 2단계 운영 범위 | 단일 로컬 API 세션 잠금. 다중 API 분산 잠금·대규모 본문 검색·영구 삭제/휴지통 보존기한은 미구현. 자료/대화는 기존 Docker Postgres이며 소스 복사만으로 DB 백업이 되지 않음 |
| 23 | 3단계 복구 범위 | 승인된 64 KiB 이하 UTF-8 파일 쓰기만. 명령은 작업 폴더 읽기 전용. 삭제/이동/권한/DB/외부 서비스 롤백·의존성 설치는 미지원 |
| 24 | 3단계 동시성·내구성 | 단일 API 메모리 잠금·해시 비교. 다중 서버·악의적인 호스트 경로 교체·전원 차단의 파일/DB 원자성은 미보장. 4단계 정상 종료/통합 백업을 추가했지만 강제 전원 차단 무손실을 보장하지 않음 |
| 25 | 검증 의미 | 지정 명령 0 종료는 전체 요구사항 정답 보장이 아니다. 파일 해시는 저장 확인일 뿐 동작 검증이 아니며, 복구/수동 수정 후 재검증해야 함 |
| 26 | 4단계 백업 위치·범위 | 같은 T7 백업은 디스크 고장/분실 대비가 아님. 모델/DuckDB/Parquet/Redis 큐/다른 workspace/비밀 설정 제외. DB·파일 내용은 민감할 수 있고 exFAT chmod는 기밀성 보장이 아님 |
| 27 | 4단계 복원·배포 | 새 DB/폴더의 격리 검사만 수행. 운영본 전환/경로 메타데이터 재매핑/다른 Mac 설치/키 복구/강제 전원 차단 검증 미수행. 재설치 패키지는 의존성·설정·모델이 별도인 소스 묶음 |
| 28 | 4단계 실패 보존·보안 | 불확실한 DB 작업 종료 시 maintenance.lock을 보존한다. 자동 삭제 금지. HMAC 키 없으면 복원 불가; 키·백업 모두 변조 가능한 로컬 사용자 방어는 아님. 실패 .partial/복원 DB·폴더는 남아 용량 관리 필요 |
| 29 | 의존성 감사 게이트 범위 | high 이상·프로덕션 의존성만 차단. moderate/low·개발 전용은 통과. `pnpm audit` 는 npm 권고 서비스 가용성에 의존. 권고의 실제 악용 시험은 하지 않았다 |
| 30 | **운영 이미지 빌드 불가 — 수정·격리 기동 검증 완료(2026-09-19)** | 기존 Node20/engines22 충돌을 clean HEAD에서 재현한 뒤 Node22·pnpm9.12.0으로 정렬했다. 실제 api 이미지 빌드·격리 `/healthz`/`readyz` 200·인증 401·일반 사용자 실행·종료0, 버전 계약 결함 주입과 Docker 컨텍스트 제외 시험 확인. CI에는 정적 버전 계약만 추가했으며 2026-09-20 `15218c0` 원격 CI audit·verify 성공. msgpackr 선택 네이티브 경고/가속 미사용은 남고 worker·migrate·amd64·실제 모델은 이번 범위 밖이다. 원인/실패/근거: `docs/30-container-build.md` |
| 31 | 검증 하네스 ↔ 도구 jail 충돌(macOS) — **수정·검증 완료(2026-09-22)** | 제품 jail은 유지하고 phase4·5·6·7·s2 하네스가 공용 실경로 임시 작업공간과 정확한 정리를 쓴다. phase7의 실제 fixture 읽기 단언과 phase6의 `ToolResult.ok` 검사를 추가했다. 정규화를 모두 제거한 결함 주입에서 신규 시험 0/1 실패, 원복 `cmp` 일치. `TMPDIR` 우회 없이 phase4 48/48, phase7 36/36×3, phase6 16/16, s2 23/23, 정적4·단위465 PASS. 과거 34/35 실패 뒤 최신 35/35 거짓 PASS도 보존한다. 상세 `docs/32-tmpdir-harness.md` |
| 32 | API 오류 분류 잡음 — **수정·검증 완료(2026-09-22)** | 실제 소켓 이탈의 제한된 오류만 debug로 분리하고 살아 있는 AbortError·일반 예외는 500+error를 유지한다. HTTP path-param 전체 감사에서 UUID DB 경로 5개를 모두 DB 전에 검증했다. 실제 PG에서 core 3경로 500→400·하위 호출0, 결함 주입 시 메시지2·TCP1·core3 시험 실패, 관련83/83·정적4·단위473 PASS. 8791 재기동·Fastify4·다른 OS/프록시는 미검증. 상세 `docs/33-api-error-classification.md` |
| 33 | Colima T7 공유 연결 실패 — 현재 복구(2026-09-20) | 사용자 승인 후 `colima stop` → `colima start`로 VM에서 T7 경로 stat 정상, 시작기 bind probe 통과. 같은 기존 DB/Redis 컨테이너가 healthy, API·워커 ready, 통계 브라우저4/4·채팅 응답/저장3/3. 삭제·초기화·공유 설정 변경 없음. 재연결 후 재발 가능성과 원인 자체는 미해결이며 신규 자료 적재와는 구분한다. 상세 `docs/31-bigdata-connection.md` |
| 34 | phase5 전체 시나리오의 기존 실패(1-2와 분리) | 2026-09-22 우회 없는 tmpdir 점검에서 파일 도구 경로는 정상이나 29/31. 로컬 모델이 첫 함수의 named export를 빠뜨렸고, `step8.context_assembled`는 현재 `# Reference excerpts` 대신 옛 `Relevant code` 문자열을 찾는다. tmpdir 수정 범위에서 고치거나 성공으로 바꾸지 않았다. `docs/32` §6 |
| 35 | e2e 서버 인증 전제 오분류 — **수정·검증 완료(2026-09-22)** | `verify-all e2e`가 건강한 키 인증 서버를 실행해 제품 회귀처럼 보이던 실패를 만들었다. 공개·DB 비변경 capability가 `local-no-auth`일 때만 자식을 실행하며 키 인증·오응답·503·연결 끊김·잘못된 URL은 BLOCKED/INCOMPLETE다. 결함 주입, API11/11·오케스트레이터15/15·정적4·단위475 PASS. 실제 Chromium 123개는 이번 변경 뒤 미실행. 상세 `docs/34-e2e-server-precondition.md` |
| 36 | dev-up의 pnpm 명령 탐색 실패 은폐 — **수정·검증 완료(2026-09-22)** | 백그라운드 `nohup pnpm` 실패가 `/tmp/aios-api.log`에만 남아 90초 뒤 일반 API 장애로 보였다. 일반 기동은 설정·서비스·키 전에 pnpm PATH를 확인하고 정확한 AGENTS PATH를 안내하며, export-only는 기존처럼 예외다. 결함 주입 2/3 PASS·1/3 FAIL, 고정3/3·local-ops1/1·정적4·단위475 PASS. 정상 전체 기동·원격 Linux CI는 미실행. 상세 `docs/35-dev-up-pnpm-preflight.md` |
| 37 | 로컬 모델 ID 명시 선택 실패 | 2-1 검증 중 기존 `AiRouter.rank({model:"qwen3:8b"})`가 동적 로컬 카탈로그 대신 정적 `findModel`을 조회해 `unknown_model`을 내는 것을 실행으로 확인했다. 이번 통합 잡은 로컬 모델 하나를 등록하고 자동 선택을 사용한다. 제품 수정은 별도 항목이며 `docs/37`에 실패를 보존했다. |
| 38 | 조립한 API의 자연 종료 | 2-1 검사에서 HTTP·DB 정리를 마친 뒤에도 Redis 연결이 남았다. 레거시 WS 구독에 onClose 해제가 없고 작업 큐 연결도 프로세스에 남을 수 있다. 제품 main과 같은 명시적 종료를 쓰며 자연 종료·자원 누수 개선으로 주장하지 않는다. `docs/37` |

---

## 8. 함정 모음 — 전부 실제로 밟은 것

| 증상 | 원인 | 대응 |
|---|---|---|
| vitest·eslint·glob·마이그레이션이 이상한 파일을 읽음 | exFAT 가 `._*`(AppleDouble) 사이드카를 만든다 | 모든 glob 에서 `._*` 제외(이미 설정됨). 새 glob 에도 적용 |
| 한글 경로 비교가 0건 | 맥 파일명은 NFD, 코드 문자열은 NFC | 비교 전 `normalize("NFC")`. DuckDB 는 `hive_partitioning=false` |
| Playwright `ENOTEMPTY` | exFAT 는 하드링크·원자적 rename 이 약하다 | 결과 디렉터리는 APFS `tmpdir()` (T7 예외 허용 항목) |
| `$PNPM --filter` 가 "no such file" | zsh 는 따옴표 없는 변수를 단어 분할하지 않는다 | `node /usr/local/lib/node_modules/corepack/dist/pnpm.js ...` 직접 호출 |
| 대기 루프가 영원히 안 끝남 | `ps \| grep`·`pgrep -f` 가 **자기 자신의 명령줄**을 매칭 | 매칭 패턴에 `[p]attern` 을 쓰거나 PID 로 기다린다 |
| `eval "$(dev-up.sh ...)"` 가 20분간 반환 안 함 | 명령 치환은 백그라운드 자식이 상속한 fd 가 닫힐 때까지 기다린다(리다이렉션은 0·1·2만 덮음) | `--export-only` 는 기동하지 않게 분리함 |
| 로컬 LLM 요청이 `UND_ERR_HEADERS_TIMEOUT` | Node 내장 fetch 헤더 타임아웃 300초 고정, 로컬 서버는 큐 대기 중 헤더를 안 보낸다 | 로컬 어댑터만 npm undici fetch + 무제한 헤더 타임아웃. **내장 fetch 는 npm undici 의 Agent 를 거부한다** |
| 컨테이너만 부팅 실패 | undici@8 은 Node ≥22.19 요구, 이미지는 Node 20 | `undici@^7` 고정 + `.npmrc` `engine-strict=true` |
| 사고 모델이 빈 응답 | max_tokens 를 사고와 응답이 나눠 쓴다 | `THINKING_HEADROOM` 을 더한다(라우터·eval·벤치 모두) |
| DuckDB 두 번째 도구 호출 실패 | `lock_configuration` 은 인스턴스 전역 | 인스턴스 생성 시 한 번만 설정 |
| 복구한 벡터로 유사도 질의 실패 | Parquet 왕복에서 `FLOAT[1024]` → `FLOAT[]` | 복구 시 차원 캐스팅(`scripts/backup-bigdata.sh` 의 RESTORE.md) |
| compose `service not running` 인데 DB 는 살아 있음 | compose 프로젝트 이름이 **폴더 경로**에서 나온다 — 폴더를 옮기면 고아가 된다 | 현재 프로젝트명 `1ai`. 옛 `1_*` 볼륨 잔존(안정화 후 삭제 가능, 사용자 확인) |
| 배포 검증이 옛 코드를 검증 | 고정 태그 이미지를 재사용했다 | phase8 은 매번 새로 빌드(고유 태그)·종료 시 삭제 |
| 초록인데 아무것도 안 잼 | 즉시 참이 되는 대기, 상한만 보는 단언, 표본 0 | 하한 단언·표본 수 강제·**결함 주입으로 확인** |
| 채점기가 정답을 오답 처리 | 정규식으로 TS 타입을 지우다 삼항 `: x` 를 먹음 | esbuild 트랜스파일 사용 |
| 뚜껑 닫으면 작업 중단 | 잠자기(현재 잠자기 방지는 유휴만) | 오래 걸리는 작업 전 전원·`caffeinate -dimsu` 확인 |
| 기기가 이유 없이 느리고 부하 평균 10~19 | **tsx 가 띄운 esbuild 서비스(`--service=0.28.1 --ping`)가 부모 node 가 죽은 뒤 고아로 남아 헛돈다.** 2026-09-07 에 SIGBUS·`kill -9` 로 서버를 정리하면서 2개가 생겨 **4일 반 동안 각 CPU 340%**(코어 약 7개)를 먹었다. SIGTERM 도 무시한다 | 아래 §11 의 점검 명령. 부모가 launchd(PPID 1)인 esbuild 는 전부 고아다 |
| e2e 가 `session.id` 가 `undefined` 라며 실패, 서버 로그에 `/v1/sessions/undefined/messages` | e2e 스펙은 `request.post("/v1/sessions")` 를 **인증 헤더 없이** 부른다 — **키 없는 서버(`LOCAL_NO_AUTH=1`)를 전제**한다. `dev-up.sh` 서버는 키 인증이라 401 | `verify-all e2e`는 이제 키 인증 서버를 자식 실행 전에 BLOCKED로 분류한다. 실행하려면 `LOCAL_NO_AUTH=1 PORT=8792 pnpm --filter @aios/api dev` 후 `AIOS_BASE_URL=http://127.0.0.1:8792`; API 키는 필요 없다. 과거 123 PASS/3 skip을 현재 통과로 재사용하지 않는다 |
| `AIOS 시작.command` 가 "시작기 작업 폴더를 확인할 수 없습니다" | 시작기가 자기 프로세스의 cwd 를 `lsof` 류로 확인해 저장소 루트와 비교한다(`scripts/local-lifecycle.mjs:228`). 에이전트 하네스 하위 프로세스에서는 통과하지 못했다 | 사용자의 Finder 더블클릭/일반 터미널에서 실행. 에이전트는 위 키 없는 서버를 직접 띄운다 |
| `dev-up.sh`가 pnpm을 찾지 못함 | 셸의 PATH에 corepack 셔임이 없다(에이전트 셸은 사용자 프로필을 다 읽지 않을 수 있다) | 시작기가 이제 서비스 전에 직접 원인과 전체 PATH 명령을 출력한다. 안내대로 적용한 뒤 `command -v pnpm`이 `/usr/local/lib/node_modules/corepack/shims/pnpm`인지 확인한다. 과거처럼 일반 `API 서버가 뜨지 않았다`만 보이면 `docs/35` 회귀 시험을 확인한다 |
| 서버를 종료했는데 `pnpm … dev` / `tsx` 프로세스가 남아 있음(ppid=1) | 리스너 PID 만 종료하면 부모 래퍼와 tsx 자식이 고아가 된다 | 리스너가 아니라 **`--filter @aios/api dev` 래퍼 PID** 를 SIGTERM. 이후 §11 점검(`ps` 로 `esbuild` ppid=1 확인) |
| `git` 이 "You have not agreed to the Xcode license" 만 출력 | `/usr/bin/git` 셔임이 Xcode 라이선스 동의(sudo)를 요구 | `/Library/Developer/CommandLineTools/usr/bin/git` 를 직접 호출. GitHub 쪽은 `gh` |

---

## 9. 코드 지도

```
apps/api            Fastify API · SSE 채팅 · WS 협업 · 에이전트 오케스트레이터(src/agent/orchestrator.ts)
                    bigdata-process.ts / bigdata-worker.ts: DuckDB 자식 프로세스 격리·재기동
apps/web            React+Vite 웹 UI (해시 라우터, 의존성 최소) · e2e/ Playwright
apps/cli            aios CLI
apps/verify         검증 하네스(src/*.ts) · eval(src/eval/)
packages/ai         프로바이더 어댑터(providers/local.ts 가 오프라인 핵심) · 라우터 · 프롬프트 · 완료 게이트
packages/memory     STM(Redis) + LTM(pgvector, 1024차원) — 중복 판정은 2단계(정규화 일치 + 코사인 0.97·수치 일치)
packages/tools      도구 레지스트리·실행기 · fs(경로 감옥, .git 차단) · git · 샌드박스 · bigdata(DuckDB)
packages/indexer    증분 인덱서 · 청커 · 하이브리드 RAG
packages/collab     Yjs CRDT + Redis 팬아웃
tools/bigdata       Python 적재기(build.py: catalog/facts/enrich/db/embed/rebuild/verify) · 모델 벤치
scripts/            dev-up · verify-all · 백업/복구 · 마이그레이션 · 개발 키 발급
                    start-local.sh / verify-local-use.mjs / verify-local-recovery.mjs: 사용자 시작·실사용 검증
infra/              Dockerfile · 마이그레이션 SQL(0001~0004, 0004는 일상 작업공간) · Helm 차트
docs/               설계·검증 문서 — 01~09 설계, 10·final 검증 보고서, 11 배포, 12 Sprint3, 13 웹 UI, 14 오프라인·빅데이터
```

**데이터 자산(T7):** `bigdata/bigdata.duckdb` 2.5GB(재생성 가능) · `parquet/` 898MB · `ollama-models/` 19GB ·
`playwright-browsers/` 718MB · `backups/` · `secrets/`. DuckDB 는 `tools/bigdata/build.py rebuild` 로 Parquet 에서 재생성한다.

---

## 10. 보안 메모

- 과거 대화에서 **Anthropic API 키가 평문으로 노출**됐다. 현재 `.env` 에는 키 줄이 없다. **폐기·재발급을 사용자에게 권할 것.**
- 원본 데이터 폴더 `00_인덱스/` 에 공공데이터 API 키 평문 파일 4개(`_KOSIS_/_KMA_/_NAVER_/_SEOUL_APIKEY.txt`)가 있다.
  저장소·문서·로그로 옮기지 말 것.
- 비밀은 `.env`·`.env.local`(gitignore)과 `/Volumes/T7/bigdata/secrets/` 에만 둔다.
- 의존성 취약점: `pnpm run audit:prod`(high 이상·프로덕션). 결과가 나오면 `docs/08-security.md` §15.5 의 방식으로 조치한다 — 메이저 업그레이드는 타입 검사가 못 잡는 동작 변경이 있으므로 프리플라이트·정적 서빙처럼 **브라우저 경계**를 직접 시험한다.

---

## 11. 작업을 마칠 때

1. `node scripts/verify-all.mjs typecheck lint unit build` 최소 통과, 기능을 건드렸다면 해당 라이브 단계까지.
2. 새 테스트는 결함 주입으로 검출력을 확인했다고 적는다.
3. `docs/` 해당 장과 이 문서의 §0·§6·§7 을 갱신한다.
4. 백그라운드 작업·임시 디렉터리(`$TMPDIR/aios-*`)·검증용 Docker 이미지를 정리한다.
5. **고아 esbuild 서비스를 확인한다** — 서버·검증을 강제 종료했다면 반드시.
   ```bash
   ps -Ao pid,ppid,pcpu,comm | awk '$4 ~ /esbuild$/ && $2 == 1'   # 출력이 있으면 고아다
   ps -Ao pid,ppid,comm | awk '$3 ~ /esbuild$/ && $2 == 1 {print $1}' | xargs -r kill -KILL   # SIGTERM 은 무시한다
   ```
   `ps | grep esbuild` 로 찾지 말 것 — 명령줄에 그 단어가 든 자기 셸까지 잡힌다(§8). 위처럼 실행 파일 이름(comm)으로 본다.
