# 브라우저 e2e 서버 전제 판별

> NEXT_STEPS 1-4의 완료 기준 사전 등록. 2026-09-22, 수정 전 작성.

## 1. 범위와 최초 재현

- 기준 커밋: `8949623` (`git status`가 깨끗한 상태).
- HEAD의 `verify-all.mjs`를 정확히 복사한 격리 fixture에서 `/healthz`는 200, 자격증명 없는 `/v1/me`는 401인 키 인증 서버를 만들었다.
- `AIOS_BASE_URL`과 합성 `AIOS_API_KEY`를 둔 `verify-all e2e`는 `/healthz`만 확인한 뒤 e2e 자식을 실제 실행했다. 합성 pnpm이 호출됐고 결과는 **FAIL**이었다. 출력에는 BLOCKED나 인증 모드 이유가 없었다.
- 실제 8790·8791 서버는 작업 시작 시 모두 내려가 있었다. 기존 실제 실행에서는 키 인증 서버의 인증 없는 `POST /v1/sessions`가 401이 되어 `session.id`가 undefined로 이어지고 e2e 7건이 실패했다는 근거가 `HANDOFF.md` §8과 `docs/08-security.md`에 남아 있다. 이번에는 사용자 서버를 재기동하거나 사용자 DB에 합성 대화를 만들지 않았다.

격리 재현 원문은 `/Volumes/T7/bigdata/verification-reports/next-1-4-head-key-auth-fixture.log`에 둔다.

## 2. 원인

`verify-all.mjs`의 서버 전제는 `AIOS_BASE_URL`·`AIOS_API_KEY` 존재와 `/healthz` 200만 확인한다. 그러나 브라우저 스펙 일부는 Playwright의 독립 `request` fixture로 세션을 만들며 Authorization 헤더를 넣지 않는다. 따라서 이 e2e 묶음은 `LOCAL_NO_AUTH=1` 서버 전용인데, 오케스트레이터가 실제 인증 모드를 확인하지 않고 자식을 실행한다.

또한 로컬 무인증 서버에서는 UI가 `/v1/me`로 바로 인증되므로 e2e에 API 키가 필요 없지만, 현재 공통 `hasServer` 조건은 모든 서버 단계에 키를 요구한다. 이 때문에 올바른 서버에도 의미 없는 더미 키를 넣게 된다.

## 3. 수정 전 완료 기준

아래를 모두 만족해야 1-4를 완료로 바꾼다.

1. e2e 선택에는 `AIOS_BASE_URL`만 필수다. 다른 서버 의존 단계의 `AIOS_API_KEY` 전제는 바꾸지 않는다.
2. 공개·읽기 전용 `/v1/auth/providers`가 `authMode: "local-no-auth"`를 반환한 경우에만 Browser E2E 자식을 실행한다. 이 endpoint는 환경 설정만 읽고 DB를 호출하지 않아야 한다.
3. `authMode`가 `credentials-required`이거나 응답을 판별할 수 없으면, e2e 실행 전에 **BLOCKED**와 `LOCAL_NO_AUTH=1`이 필요한 이유를 출력한다. 최종 판정은 FAIL이 아니라 INCOMPLETE(exit 2)다.
4. 실제 HTTP 격리 fixture에서 키 인증 서버는 pnpm 자식을 전혀 실행하지 않고 BLOCKED, 로컬 무인증 서버는 API 키 없이 자식을 실행해 PASS 한다.
5. 인증 모드 사전 검사를 제거하는 결함 주입에서 키 인증 fixture 시험이 실패해야 한다. 원복 후 `cmp`가 일치해야 한다.
6. 관련 오케스트레이터 시험과 기본 정적 4단계가 PASS 한다. 결과 원문은 T7에 보존한다.
7. 이 작업이 만든 정확한 HTTP 서버·HEAD 사본만 정리한다. 실제 사용자 서버, DB, 외부 키, push는 사용하지 않는다.

## 4. 비범위

- 현재 e2e 전체를 키 인증 서버에서도 동작하게 바꾸지 않는다. 스펙 전체에 인증 헤더를 주입하는 것은 별도 설계이며 기존 로컬 제품 회귀의 전제를 바꾼다.
- 사용자용 8791 또는 개발용 8790을 자동으로 시작·종료하지 않는다.
- e2e 자체의 123개 동작을 이 전제 검사로 다시 통과했다고 주장하지 않는다. 올바른 실제 서버가 없으면 전체 브라우저 실행은 미검증으로 남긴다.

## 5. 수정

- 공개 `/v1/auth/providers` 응답에 `authMode: "local-no-auth" | "credentials-required"`를 추가했다. 환경 설정만 읽으며 이 판별에서 DB를 호출하지 않는다.
- Browser E2E 단계에만 `needsLocalNoAuth` 전제를 붙였다. 이 단계는 `AIOS_BASE_URL`만 요구하고, 다른 서버 의존 단계의 주소+키 계약은 유지한다.
- `/healthz` 200 뒤 `/v1/auth/providers`의 정확한 `local-no-auth` 신호를 확인한 경우에만 Playwright 자식을 실행한다. 키 인증 또는 판별 불가 응답은 이유를 포함한 BLOCKED로 끝낸다.
- 익명 `/v1/me` 판별안은 구현 중 폐기했다. 로컬 인증 경로가 최초 조직을 upsert할 수 있어 “검사 전에 사용자 상태를 바꾸지 않는다”는 목적에 맞지 않았기 때문이다.

## 6. 결함 주입

1. e2e 단계의 `needsLocalNoAuth` 표식을 제거하자 실제 CLI 격리 시험은 **11/13 PASS, 2/13 FAIL**이었다. 키 서버가 차단되지 않았고, 올바른 로컬 서버는 API 키가 없다는 이유로 실행되지 않았다.
2. `/v1/auth/providers`가 설정과 무관하게 항상 `local-no-auth`를 반환하도록 바꾸자 API 시험은 **10/11 PASS, 1/11 FAIL**이었고 키 인증 모드 오분류를 검출했다.
3. 두 파일을 원복한 뒤 `cmp`가 성공했다. **해당 결함 주입 원복 직후** `verify-all.mjs`의 두 SHA-256은 `08a6dc66e3173704541dc1286331c9d85a9d79de2d08ba38b022766e332ddab8`, `auth.ts`의 두 SHA-256은 `fdb16e2ed5eb2fac28e38d6d1f3c2bf07c5347097c7f074b0369c568d55dfd05`로 각각 일치했다. 이후 마감 감사에서 발견한 잘못된 base URL 예외 처리를 추가했으므로 앞 해시는 최종 파일 해시가 아니다.

실패 출력:

- `/Volumes/T7/bigdata/verification-reports/next-1-4-fault-preflight.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-4-fault-auth-mode.log`

## 7. 실행 결과

| 실행 | 결과 |
|---|---:|
| 수정 전 HEAD 키 인증 HTTP fixture | **FAIL**, exit 1, pnpm 자식 실행 **1회**, 요청은 `/healthz`만 |
| 수정 후 키 인증 HTTP fixture | **BLOCKED/INCOMPLETE**, exit 2, pnpm 자식 실행 **0회** |
| 수정 후 로컬 무인증 HTTP fixture | API 키 없이 자식 실행 **1회**, 합성 자식 PASS |
| capability 오응답·503·연결 끊김 fixture | 세 경우 모두 **BLOCKED/INCOMPLETE**, 자식 실행 **0회** |
| 잘못된 `AIOS_BASE_URL` CLI fixture | 스택 노출 없이 **BLOCKED/INCOMPLETE**, 자식 실행 **0회** |
| 인증 capability API 시험 | **11/11 PASS**, 두 모드 모두 DB 호출 0회 |
| 검증 오케스트레이터 시험 | **15/15 PASS** |
| 기본 정적 4단계 | **4/4 PASS** — 단위 **475/475**, 실패·SKIP·todo 0 |

HTTP fixture는 실제 `verify-all.mjs` CLI, 실제 HTTP 서버, 실행 여부를 판별할 수 있는 합성 pnpm 자식을 사용했다. 키 서버는 `/healthz`와 `/v1/auth/providers`만 요청받고, BLOCKED 이유에 `LOCAL_NO_AUTH=1`을 명시했다. 로컬 서버는 같은 두 요청 뒤 자식을 실행했다. 오응답·503·capability 연결 끊김도 같은 두 요청 뒤 자식을 실행하지 않았다. 별도 CLI fixture는 문법적으로 잘못된 base URL도 예외 스택이나 자식 실행 없이 같은 이유로 차단함을 확인했다. 원문은 `next-1-4-fixed-key-auth-fixture.log`, `next-1-4-fixed-local-no-auth-fixture.log`, 표적 성공은 `next-1-4-auth-mode-fixed.log`·`next-1-4-preflight-final.log`, 최종 정적 결과는 `verify-1790074714048-c0f1c519-28a4-4f49-a6c4-37be5bee638f.json`에 있다.

## 8. 확인하지 못한 범위

- 실제 8790·8791 서버는 내려가 있어 재기동하지 않았다. 실제 Chromium e2e 123개를 이번 변경 뒤 재실행하지 않았으며 브라우저 기능 통과로 주장하지 않는다.
- “키 서버에서 7건 실패”는 과거 관측치다. 현재 스펙에는 로컬 운영 화면 전제도 추가돼 있어 지금 다시 돌렸을 때 정확히 7건이라고 단정하지 않는다.
- 합성 pnpm의 PASS는 오케스트레이터가 올바른 조건에서 자식을 실행했다는 뜻일 뿐, 실제 브라우저 시험 PASS가 아니다.
- 외부 AI API 키, 실제 API 키, 사용자 DB·대화, 공개 체험판, 다른 OS는 사용하거나 확인하지 않았다.

## 9. 정리

- 작업 중 만든 `/Volumes/T7/bigdata/tmp/aios-head-1-4-8949623`, `/Volumes/T7/bigdata/tmp/aios-fixed-1-4`, `/Volumes/T7/bigdata/tmp/aios-1-4-mutation-8949623`만 정확한 경로로 정리했고 세 경로가 모두 사라졌음을 확인했다.
- 작업용 HTTP 서버는 각 fixture 종료 시 닫혔고, 8790·8791에는 새 리스너가 없었다. 작업 경로를 가리키는 잔존 프로세스나 esbuild 프로세스도 없었다.
- 검증 로그는 `/Volumes/T7/bigdata/verification-reports/`에 보존했다. 저장소 push, 배포, 실제 키 사용, 사용자 데이터 변경은 하지 않았다.
