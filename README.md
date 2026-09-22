# AIOS — AI Operating System

**자료를 연결해 대화하고, AI의 작업을 승인·검증·복구하는 로컬 AI 작업공간.**

현재 주력으로 개발하는 메인 프로젝트입니다. AI와 함께 구현하고 실제 사용·결함 주입·회귀 시험으로 보완하고 있습니다.
Ollama 기반 로컬 모델로 외부 AI API 키 없이 주요 작업 흐름을 사용합니다. OpenAI·Claude·Gemini·Grok 어댑터도 구현했지만 모든 외부 서비스의 실계정 동작을 검증했다는 뜻은 아닙니다.
이름의 Operating System은 작업 환경이라는 의미이며, 독자적인 OS 커널은 아닙니다.

`TypeScript` · `React` · `Fastify` · `PostgreSQL / pgvector` · `Redis / BullMQ` · `Yjs` · `Ollama` · `Docker`

## 설치 없이 살펴보기

**[AIOS 공개 체험판 열기 ↗](https://aios-demo-mu.vercel.app)**

별도 공개 체험판은 **자료 확인 → 변경 제안 → 승인/거절 → 검증 → 복구/충돌** 흐름을 가상 문서로 보여줍니다.
실제 AI 응답이나 파일 실행이 아니며, 로컬 AIOS 서버·개인 파일·API 키에 연결하지 않습니다. 입력과 변경은 현재 탭의 메모리에만 남고 초기화/새로고침하면 사라집니다.

소스를 복제한 뒤 `pnpm install --frozen-lockfile`, `pnpm run doctor --demo`, `pnpm demo`로 체험판만 실행할 수도 있습니다. Docker·Ollama·T7 설정은 필요하지 않습니다.
[체험판의 범위와 배포 검증](docs/24-public-demo.md) · [처음 설치하는 사람의 안내](docs/23-getting-started.md) · [냉정한 평가표와 100점 수용 조건](docs/22-project-scorecard.md)

## 핵심 흐름

| 단계 | 사용자가 확인하는 것 |
|---|---|
| 대화·자료 | 대화 검색/휴지통, 대화별·프로젝트 공용 참고자료, 범위가 표시되는 답변 선호 기억과 파일·행 출처 |
| 작업 승인 | 파일 변경 전·후 내용과 실행 명령을 보고 건별 승인 또는 거절 |
| 실행 검증 | 실제 종료 코드·파일 해시·지정 검증 명령 결과. 모델의 ‘완료’ 문구와 구분 |
| 변경 복구·운영 | 수동 변경을 덮어쓰지 않는 파일 복구, 정상 종료, 통합 백업과 격리 복원 검사 |

**최근 검증 범위:** 이식 가능한 단위 시험 450개, 새 DB·실행 소유권·복구 내구성 25개 통과. 개발 Mac의 전체 브라우저는 123개 통과/3개 해당 없음이며 실제 API와 합성 API 검사가 섞여 있습니다. 자료 기반 대표 업무 3건은 실제 모델·승인·파일 검증·복구까지 통과했습니다.
이는 모든 AI 응답의 정확도나 다른 컴퓨터에서의 무설정 실행을 보장하지 않습니다. [최신 검증 범위](docs/28-release-verification.md), [대표 업무의 실패와 개선 기록](docs/29-representative-workflow.md), [과거 통합 백업·복원 근거](docs/20-stage4-local-operations.md)를 구분해 공개합니다.

## 현재 실행 범위

현재 실제 AI·파일 작업을 하는 직접 사용판은 **macOS + T7 + Colima/Docker + Ollama** 설정에 맞춰져 있습니다. 공개 체험판과 별개인 로컬 제품이며, 복제만으로 데이터·모델·비밀 설정이 설치되지는 않습니다.
GitHub에는 소스·설정 예제·문서·테스트만 올립니다. 대화 DB, 작업 파일, 백업, 모델, API 키는 포함하지 않습니다.

**이 Mac에서 직접 사용:** T7를 연결하고 프로젝트 폴더의 **AIOS 시작.command**를 더블클릭하세요.
준비 후 `http://127.0.0.1:8791`이 열립니다. 사용법과 작업 파일 위치는 [처음 사용하기.md](처음%20사용하기.md)를 참고하세요.

현재 4단계 로컬 운영 준비까지 적용했습니다. 시작·종료·실시간 상태 확인, 변경 없는 빌드 재사용, DB+작업 파일+체크포인트 통합 백업과 격리 복원 검사, 설정의 운영 안내를 제공합니다.
**AIOS 종료.command → AIOS 백업.command → AIOS 복원 검사.command → AIOS 시작.command** 순서로 백업과 복원 가능 여부를 확인하세요. 기존 운영 데이터를 자동 교체하지 않습니다.
범위·키 보관·실제 검증과 한계는 [4단계 로컬 운영](docs/20-stage4-local-operations.md)에 있습니다. 모델·대용량 통계는 통합 백업에 포함되지 않으며 같은 T7 백업은 디스크 고장 대비책이 아닙니다.

3단계의 파일 변경·명령 실행 건별 승인, 실제 종료 코드·파일 해시 확인, 실행 기록과 충돌 방지 복구도 유지합니다.
**도구 사용 허용 → 작업 내용 확인 → 이번 작업 승인**으로 실행합니다. 선택한 검증 명령이 없으면 동작 미검증으로 표시합니다.
범위·제한은 [3단계 안전 실행](docs/19-stage3-execution-safety.md), 대화·자료 기능은 [2단계 작업공간](docs/18-stage2-daily-workspace.md)에 있습니다.

> **이어서 작업한다면 [HANDOFF.md](HANDOFF.md) 부터 읽어라** — 현재 상태·기동·다음 할 일·함정.
Prompt Router / Memory Engine(STM+LTM) / Tool Calling / MCP / RAG / 실시간 협업 / 플러그인 마켓플레이스 / VSCode 확장 / CLI / SDK.

## 문서 (설계 이유 포함)

| 문서 | 내용 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 전체 아키텍처, 기술 스택 결정 근거 |
| [docs/02-data-model.md](docs/02-data-model.md) | ERD, DB 스키마 모델링 결정 |
| [docs/03-sequences.md](docs/03-sequences.md) | 핵심 시퀀스 다이어그램 5종 |
| [docs/04-api-spec.md](docs/04-api-spec.md) | REST/SSE/WebSocket 명세 |
| [docs/05-plugin-system.md](docs/05-plugin-system.md) | 플러그인 capability 모델, 마켓플레이스 |
| [docs/06-engines.md](docs/06-engines.md) | Prompt / Memory / Tool / Router 엔진 설계 |
| [docs/07-scaling-cost-bottleneck.md](docs/07-scaling-cost-bottleneck.md) | 스케일링 3단계, 비용, 병목 9종 |
| [docs/08-security.md](docs/08-security.md) | 위협 모델(프롬프트 인젝션 포함), RBAC |
| [docs/09-testing-cicd.md](docs/09-testing-cicd.md) | 테스트 피라미드 + eval, 배포 파이프라인 |
| [docs/11-deployment.md](docs/11-deployment.md) | **배포 가이드** — Compose / Kubernetes(Helm) / 관리형 조합, 무중단 업데이트·카나리·롤백·백업·복구 |
| [docs/final-verification-report.md](docs/final-verification-report.md) | **최종 검증 보고서 (Sprint #2, 301 checks)** — PASS/FAIL, 결함 14건, 성능·비용·보안·배포 준비 상태 |
| [docs/10-verification-report.md](docs/10-verification-report.md) | 1차 실기동 검증 리포트 (Phase 1–8, 229 checks) |
| [docs/12-sprint3-completion.md](docs/12-sprint3-completion.md) | Sprint #3 — 협업·마켓플레이스·결제·OAuth 보완 |
| [docs/13-web-ui.md](docs/13-web-ui.md) | 웹 UI — 접근성·반응형·Playwright·색 대비 |
| [docs/14-offline-bigdata.md](docs/14-offline-bigdata.md) | **API 키 없이 운영** — 로컬 LLM, 2.5억 행 데이터 계층, 실측 성능 |
| [docs/15-local-readiness.md](docs/15-local-readiness.md) | **로컬 직접 사용 검증** — 더블클릭 실행, 실제 파일 생성·실행, 중단·통계 엔진 복구 |
| [docs/17-stage1-auto-response.md](docs/17-stage1-auto-response.md) | 1단계 — 자동 응답·정확 계산·구간 계측 |
| [docs/18-stage2-daily-workspace.md](docs/18-stage2-daily-workspace.md) | 2단계 — 대화 정리·프로젝트 자료·DB 맥락 복원 |
| [docs/19-stage3-execution-safety.md](docs/19-stage3-execution-safety.md) | 3단계 — 실행 증거·건별 승인·파일 체크포인트 복구 |
| [docs/20-stage4-local-operations.md](docs/20-stage4-local-operations.md) | 4단계 — 안전한 기동·종료·통합 백업·격리 복원 검사 |
| [docs/21-github-main-project.md](docs/21-github-main-project.md) | 공개 저장소의 범위·개발 기준·CI와 로컬 검증 구분 |
| [docs/22-project-scorecard.md](docs/22-project-scorecard.md) | 고정 배점의 평가·개선 근거·100점까지 남은 조건 |
| [docs/23-getting-started.md](docs/23-getting-started.md) | 체험판/전체 앱 준비물과 읽기 전용 설치 진단 |
| [docs/24-public-demo.md](docs/24-public-demo.md) | 공개 체험판·배포 경계·브라우저 검증 |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | 기여·재사용 권한 상태·비공개 보안 제보 |

## 구조

```
apps/api            # Fastify API + SSE 채팅 + WS 협업 + BullMQ 워커 + health/metrics
apps/demo           # 외부 API 없이 동작하는 공개 체험판 (가상 파일·모의 응답)
apps/cli            # aios CLI (login/chat/index/search)
apps/verify         # 실기동 검증 하네스 21단계 + eval(품질 회귀) 스위트
apps/web            # React+Vite 웹 UI + Playwright e2e
packages/shared     # 공유 타입·에러·env (서버/SDK/CLI/확장 공용 계약)
packages/ai         # 프로바이더 어댑터 4종, AI Router, Prompt Engine
packages/memory     # STM(Redis) + LTM(pgvector) Memory Engine
packages/tools      # Tool Registry/Executor, fs/git/docker-sandbox, MCP 클라이언트
packages/indexer    # 증분 인덱서, AST-휴리스틱 청커, 하이브리드 RAG
packages/plugin-host# worker_thread 격리 + capability bridge
packages/sdk        # 타입 안전 API 클라이언트 (의존성 0)
extensions/vscode   # VSCode 확장
plugins/hello-world # 예제 플러그인
infra/              # 마이그레이션 SQL, Dockerfile, 샌드박스 이미지, Helm 차트
tools/bigdata/      # 공공통계 적재기(Python/DuckDB), 모델 벤치
scripts/            # dev-up, verify-all, 백업/복구, 마이그레이션
```

## 빠른 시작

**로컬 모델로 (권장, 키 불필요)** — 전제: Ollama, colima, T7 마운트.
```bash
pnpm install --frozen-lockfile
[ -f .env.local ] || cp .env.example .env.local   # 없을 때만 — 있으면 작동 중인 설정이다(덮어쓰지 말 것)
./scripts/dev-up.sh               # Postgres·Redis·Ollama·API 를 올리고 export 문 출력
```

**클라우드 프로바이더로**
```bash
pnpm install --frozen-lockfile
docker compose up -d postgres redis
cp .env.example .env            # 프로바이더 키 입력
DATABASE_URL=postgres://aios:aios@localhost:5432/aios node scripts/migrate.mjs
docker build -f infra/sandbox.Dockerfile -t aios-sandbox:latest .
pnpm --filter @aios/api dev     # API :8787
pnpm --filter @aios/api dev:worker
```

## 검증

```bash
pnpm verify typecheck lint unit build    # 로컬 기본 검증
pnpm verify local-ops                    # T7/macOS 운영 결함 주입 검사
cd apps/verify && REPEATS=5 pnpm eval    # 품질 회귀 측정 (신뢰구간 포함)
```

GitHub CI는 이 로컬 환경 전체를 재현하지 않습니다. 자동 배포·모델 호출·이미지 공개 없이, 소스 정적 검사·빌드·머신 독립 단위 검사와 별도 공개 체험판의 데스크톱/모바일 브라우저 검사를 수행합니다. 체험판 통과는 실제 DB·LLM·파일 실행 통과가 아닙니다.
`pnpm verify`의 기본값은 타입·린트·이식 가능한 단위·빌드 4단계입니다. 단위 검사는 실제 결과를 집계하며 T7·실제 DB 전용 5개 파일의 제외와 시험이 없는 5개 패키지를 따로 표시합니다. 이 범위의 PASS가 실제 DB·모델·복원 시험을 뜻하지 않습니다. 오타나 0개 검사, 선택한 시험의 SKIP/차단을 전체 PASS로 표시하지 않습니다. `pnpm verify --list`로 범위를 확인하고 `--report`로 T7에 코드 지문과 결과를 저장할 수 있습니다. 자세한 범위는 [릴리스 검증](docs/28-release-verification.md)을 참고하세요.
구형 전체/phase8에는 이미지·컨테이너·테스트 DB 정리가 있으므로 별도 명시 플래그와 격리 환경 확인 없이는 시작하지 않습니다. [검증 안전 경계](docs/28-release-verification.md)를 참고하세요.

최근 전체 실행: **20 PASS / 0 FAIL / 1 SKIP** (2026-09-07). SKIP 은 `ANTHROPIC_API_KEY` 전용 단계다.
프로바이더가 필요한 단계는 로컬 모델로도 돈다. 단계 목록·조건·소요 시간은 [HANDOFF.md](HANDOFF.md) §4,
남은 위험은 [docs/final-verification-report.md](docs/final-verification-report.md) §7.

## 라이선스

AIOS의 자체 소스와 문서는 [MIT License](LICENSE)로 공개합니다. 제3자 의존성은 각각의 고유 라이선스를 따릅니다.
