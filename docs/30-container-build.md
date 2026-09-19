# 운영 이미지 빌드 복구 — 2026-09-19

## 수정 전 재현과 완료 기준

기준은 Claude 인계 커밋 `174e2dc`다. 사용자 설정·의존성·DB를 포함하지 않는 `git archive HEAD` 사본에서 기존 `infra/Dockerfile`의 `api` 타깃을 실제 빌드했다. `pnpm install --frozen-lockfile`에서 종료1, `ERR_PNPM_UNSUPPORTED_ENGINE`: 요구 `>=22.0.0`, 실제 `v20.20.2`로 실패했다. 새 변경 이전부터 있던 결함이다.

원본 로그: `/Volumes/T7/bigdata/tmp/aios-image-8AAJz7/baseline-build.log`. 첫 호출의 `--progress`는 이 Mac의 legacy Docker builder에서 지원하지 않아 종료125였다. 이 명령 오류는 제품 결함으로 세지 않았으며 지원되는 명령으로 위 실패를 재현했다.

수정 전에 완료 기준을 등록한다.

1. 프로젝트의 Node 최소 버전·pnpm 고정 버전과 이미지의 base/설치 버전을 일치시킨다. `engine-strict`는 유지한다.
2. 이 불일치를 CI에서 모델·DB 없이 검출한다. 과거 Node20 또는 다른 pnpm을 주입하면 검사가 실패해야 한다.
3. `docker build -f infra/Dockerfile --target api`를 실제 성공시키고, 사용자 DB/볼륨/설정을 연결하지 않는 별도 컨테이너에서 `/healthz` HTTP200을 확인한다.
4. `.env`, 호스트 `node_modules`, 기존 빌드·Git·시험 산출물이 Docker build context로 복사되지 않게 한다.
5. 정적 4단계와 관련 회귀를 실행한다. 실패 기록과 미검증 범위를 보존한다.

검증 대상은 이미지 빌드·기동·의존 서비스 연결이다. 실제 모델 생성·도구 승인·macOS 새 계정 설치·다른 Mac·재해 복원은 이 작업의 성공으로 주장하지 않는다. 기존 점수표를 변경하거나 점수를 가산하지 않는다. GitHub push/원격 CI는 사용자 승인 전 보류한다.

## 수정과 실행 결과

- `infra/Dockerfile`: Node 22와 pnpm 9.12.0으로 프로젝트 계약에 맞췄다. engines와 engine-strict는 완화하지 않았다. `.dockerignore`는 빌드에 필요한 경로만 허용하고 로컬 설정·의존성·산출물을 제외한다.
- `scripts/check-container-contract.mjs`: 지원 major, packageManager/직접 pnpm 의존성, 고정 lockfile 설치, api/worker 공통 runtime을 검사한다. CI verify job에서 검사기와 결함 주입 시험을 실행한다. **실제 Docker 빌드를 매번 하는 CI는 아직 아니다.**
- 재설치 소스 패키지에도 `.dockerignore`, `NEXT_STEPS.md`, `CHANGELOG.md`를 포함시켰다. 실제 tar 목록으로 확인했다.

| 실행 | 결과 | 범위/근거 |
|---|---|---|
| 수정 전 Docker api 빌드 | FAIL, 종료1 | clean HEAD `174e2dc`, Node20 엔진 충돌 재현 |
| 수정 후 Docker api 빌드 | PASS, 종료0 | Linux arm64 / Node v22.23.2, 컨텍스트 2.324MB. `fixed-build.log` |
| 격리 컨테이너 HTTP | PASS | `/healthz` 200, `/readyz` 200(postgres/redis 정상), `/` 및 JS 자산 200. index no-cache / JS immutable 확인 |
| 운영 인증·실행 권한 | PASS | 키 없는 `/v1/sessions` 401, uid/gid 1000(node). LOCAL_NO_AUTH 미설정 |
| 정상 종료 | PASS | SIGTERM 후 exit0, OOM false |
| 버전 계약 회귀 | 4/4 PASS | Node20·잘못된 pnpm·engine-strict 제거 등 변이 거부. 수정 전 실제 Dockerfile에서도 시험 실패 확인 |
| 패키지 회귀 | 6/6 PASS | 이전 구현 사본에 새 시험 적용: 필요한 파일 누락으로 2 FAIL/4 PASS, 최신 구현은 6 PASS |
| Docker 컨텍스트 표식 시험 | PASS / 보호 제거 시 FAIL | 합성 fixture의 소스 3개 포함, 환경 설정·중첩 node_modules·dist·secrets·Git·시험 결과 7경로 제외. 같은 fixture에서 `.dockerignore`만 없으면 종료1 |
| 타입·린트·이식 가능 단위·빌드 | 4단계 PASS | 단위 464/464, FAIL/SKIP/TODO 0. 호스트 빌드는 Turbo 캐시 재사용; 위 Docker에서 실제 컴파일도 성공 |
| 프로덕션 의존성 감사 | 종료0 | `pnpm run audit:prod`: 알려진 취약점 없음. 감사 서비스의 이 시점 결과이며 악용 불가능 보증 아님 |
| 인계 기록 보존 | PASS | 기존 HANDOFF §0 101줄 전체가 CHANGELOG에 정확히 일치. 새 요약 15줄 |

정적 검증 전후 코드 지문은 모두 `15e8a430c52d360eaeb6cdb7f3e3ceee7f738997b9910fa574d79685dcab348f`다. 단위 시험에서 T7/DB opt-in 5파일은 명시적으로 제외했고 시험 없는 5패키지는 PASS로 세지 않았다.

전체 정적 보고서: `/Volumes/T7/bigdata/verification-reports/verify-1789810654367-b623df8a-01b7-4cf8-a79d-8210ab6a000b.json`.
나머지 원본 로그는 `/Volumes/T7/bigdata/tmp/aios-image-8AAJz7/`에 보존한다: `baseline-build.log`, `fixed-build.log`, `contract-before.log`, `contract-after.log`, `regression.log`, `package-mutation-corrected.log`, `container-smoke-corrected.log`, `context-protected.log`, `context-unprotected.log`, `msgpackr.log`, `container-runtime.log`, `audit.log`, `history-preservation.log`.

### 실패·경고와 한계

- 원본 실패 로그를 지우지 않았다. `package-mutation.log` 첫 실행은 작업 폴더에 맞지 않는 상대 경로로 시험을 찾지 못했으므로 결함 검출로 세지 않는다. 고친 명령에서 실제 누락 assertion 2건을 확인했다.
- `container-smoke.log` 첫 하네스는 ready 응답의 `postgres` 필드를 `db`로 잘못 가정해 실패했다. 앱은 수정하지 않았고 실제 스키마를 확인한 후 `container-smoke-corrected.log`에서 검증했다.
- 빌드 중 선택 의존성 `msgpackr-extract`의 네이티브 설치 경고가 두 번 발생했다(사전 빌드 탐색 오류, 컴파일러/Python 없음). 이미지 기동 및 msgpackr 한글/중첩 객체 직렬화 왕복은 성공했고 **nativeAcceleration=false**였다. 네이티브 가속 및 큐 처리량은 미검증이며 성능 개선을 주장하지 않는다.
- 이미지 digest는 `sha256:a0e8e08520c1f0cb2c4f6c16108eadad04401d4627e18ec34812a3cc375d1579`. 이번 실행은 arm64 한 환경뿐이다. 베이스는 major 태그이며 digest pinning/amd64/worker·migrate 타깃 별도 기동은 미검증이다.
- DB와 Redis는 새 전용 네트워크/합성 계정/tmpfs로 띄웠고 호스트 볼륨·사용자 DB·설정 파일을 연결하지 않았다. API 포트도 `127.0.0.1` 임의 포트에만 연결했다. 모델 URL은 연결되지 않는 loopback 포트9를 썼다. **LLM 생성·실제 업무·마이그레이션 검증은 아니다.**
- 이번 시험 자원(API `50229a3fe981`, PG `4e0bbcd17ce3`, Redis `835edf0e01b1`, 실패 빌드 `9663310ac256`/`ccdc7196a7c2`, 네트워크 `a3aa14e5926c`, 최종 이미지와 표식 시험 이미지)을 ID로 정리했다. API 종료0을 확인했다. 소유한 tmpfs 시험 데이터는 폐기했고 재실행으로 재생성 가능하다. 원본 로그·소스는 보존한다. Docker 공유 빌드 캐시는 일괄 삭제하지 않았다.
- 정리 후 기존 DB/Redis 두 개는 계속 healthy, 이전부터 있던 중지 컨테이너 8개는 보존, esbuild 프로세스 0개다. GitHub push·원격 CI·Vercel은 미실행이며 점수 변경 없음.
