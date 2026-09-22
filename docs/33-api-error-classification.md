# API 오류 분류

> NEXT_STEPS 1-3의 완료 기준 사전 등록. 2026-09-22, 수정 전 작성. 구현·검증 커밋 `3a02beb`.

## 1. 범위와 최초 재현

- 기준 커밋: `1cdb8dd` (`git status`가 깨끗한 상태).
- 현재 소스를 별도 Fastify 서버로 띄우고 실제 로컬 PostgreSQL에 잘못된 세션 ID를 보냈다. PostgreSQL `22P02`가 전역 처리기의 미분류 오류로 들어가 **500**을 반환했다.
- 현재 `registerBigDataRoutes`와 실제 TCP 연결을 사용하고, 요청 도중 클라이언트 소켓을 끊었다. 요청의 `AbortSignal`로 중단된 질의 오류가 전역 처리기로 올라가 `unhandled error`를 **error 레벨 1건** 기록했다.
- 사용자용 8791 서버는 이 작업 시작 시 응답하지 않아 재현 근거로 쓰지 않았다. 별도 시험 서버와 기존 저장소 상태의 정확한 사본으로 원인을 분리했다.

실행 원문은 `/Volumes/T7/bigdata/verification-reports/next-1-3-*.log`에 둔다.

## 2. 원인

1. `GET`·`POST /v1/sessions/:id/messages`가 경로의 `id`를 UUID로 검증하지 않는다. 잘못된 값이 그대로 PostgreSQL UUID 비교식에 들어가 `22P02`가 되고, 전역 처리기는 `AiosError`와 `ZodError`만 4xx로 분류하므로 500과 error 로그를 만든다.
2. bigdata 라우트는 응답 소켓의 `close`에서 질의를 정상적으로 중단하지만, 그 중단 오류를 실제 연결 종료와 결합해 분류하는 경로가 없다. 따라서 클라이언트가 이미 사라진 정상 수명 종료도 서버 장애와 같은 error 로그가 된다.

## 3. 수정 전 완료 기준

아래를 모두 만족해야 1-3을 완료로 바꾼다.

1. 두 메시지 라우트가 같은 UUID 경로 스키마를 사용한다. 잘못된 UUID는 DB 조회 전에 기존 구조화된 `validation_error` **400**으로 끝난다.
2. 실제 TCP 클라이언트가 bigdata 요청 도중 연결을 끊고 질의가 중단되는 시험에서 error 레벨 로그가 **0건**이다.
3. 연결이 실제로 종료된 요청의 예상 가능한 전송·중단 오류만 조용히 처리한다. 연결이 살아 있는 `AbortError`와 일반 예외는 계속 **500 + error 로그**가 되어 실제 서버 장애를 숨기지 않는다.
4. UUID 검증을 제거하는 결함 주입에서 잘못된 UUID 시험이 실패한다. 연결 종료 분류를 제거하는 결함 주입에서 실제 TCP 시험이 error 로그를 검출한다. 원복 후 파일이 기준 사본과 같음을 `cmp`로 확인한다.
5. 관련 단위·통합 시험과 기본 정적 4단계 `node scripts/verify-all.mjs`가 PASS 한다. 결과 원문은 T7의 검증 보고서 디렉터리에 보존한다.
6. 이 작업이 만든 정확한 시험 서버·임시 사본만 정리한다. 외부 AI API 키, 사용자 데이터 변경, 제품 jail 완화, push를 사용하지 않는다.

### 3.1 첫 구현 뒤 전체 경로 감사로 확장한 완료 기준

메시지 경로와 연결 종료를 구현한 중간 커밋 `3a02beb` 뒤 전체 path-param 라우트를 읽기 전용으로 감사했다. 그 결과 같은 원인의 실제 UUID 경로가 `core.ts`에 3개 더 남아 있었다. 이를 별도 위험으로 밀어 완료 범위를 좁히지 않고, **core 수정 전에** 아래 기준을 추가 등록한다.

1. `POST /v1/projects/:id/index`, `GET /v1/projects/:id/search`, `DELETE /v1/memory/:id`도 같은 UUID 경로 스키마를 사용한다.
2. 세 경로에 `not-a-uuid`를 보내면 모두 구조화된 400이고, DB·큐·retriever·`forget`은 0회다. 권한·body 등 다른 계약은 유지한다.
3. 세 파싱을 원래 타입 캐스트로 되돌리는 결함 주입에서 신규 시험 3건이 모두 실패하고, 원복 뒤 `cmp`가 일치해야 한다.
4. 실제 로컬 PostgreSQL을 연결한 현재 라우트 재현과 수정 후 검증을 남긴다. 잘못된 UUID 때문에 DELETE SQL은 변환 단계에서 실패하며 실제 행 삭제는 없어야 한다.
5. 관련 시험과 정적 4단계를 다시 실행한다. 첫 구현 결과를 확장 수정의 검증으로 재사용하지 않는다.

## 4. 비범위

- 모든 데이터베이스 오류를 4xx로 낮추지 않는다. 입력 UUID는 라우트 경계에서 검증한다.
- 단순히 오류 이름이 `AbortError`라는 이유만으로 숨기지 않는다. 실제 요청 연결 종료 상태가 함께 확인되어야 한다.
- 사용자용 8791 서비스의 재기동이나 운영 상태 변경은 이 작업에 포함하지 않는다.

## 5. 수정

- 전역 오류 처리를 `api-error-handler.ts`로 분리해 제품 서버와 실제 라우트 시험이 같은 계약을 사용하게 했다.
- 연결 종료는 **소켓이 실제로 종료된 상태**이면서 `AbortError`, `ABORT_ERR`, `ECONNRESET`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE` 중 하나일 때만 debug로 분류하고 응답을 다시 쓰지 않는다.
- 살아 있는 연결의 `AbortError`와 일반 예외는 계속 500과 error 로그를 만든다. 단순 오류 이름만으로 서버 장애를 숨기지 않는다.
- 메시지 GET·POST가 공용 `SessionParamsSchema`의 UUID 검증을 DB 조회 전에 사용한다.
- 프로젝트 index/search와 메모리 delete도 공용 `UuidParamsSchema`로 UUID를 DB·큐·검색기·삭제 함수 전에 검증한다.
- 기존 채팅 시험의 `one`·`test`·`session` 합성 경로 ID는 새 제품 계약을 우회하지 않도록 유효한 서로 다른 UUID fixture로 바꿨다.

## 6. 결함 주입

1. 두 메시지 라우트의 UUID 파싱을 원래 타입 캐스트로 되돌리자 신규 시험은 **13/15 PASS, 2/15 FAIL**이었다. GET은 200, POST는 404가 되어 기대한 400과 DB 0회 계약을 위반했다.
2. 연결 종료 분기를 제거하자 실제 TCP 시험은 **2/3 PASS, 1/3 FAIL**이었고 level 50 로그 **1건**을 검출했다.
3. UUID 파일 원복 뒤 `cmp`가 성공했고 두 SHA-256은 `14498a3f30e3bbb89e4ab925fba1b4a029d7fb5f21da22e73515c1814dd7e63b`로 일치했다.
4. 첫 연결 종료 원복의 `cmp`는 코드가 아니라 파일 끝의 빈 줄 1개 차이로 실패했다. 이를 성공으로 세지 않고 한 줄 개행을 기준으로 고정한 뒤 같은 결함 주입을 다시 실행했다. 두 번째 원복의 `cmp`가 성공했고 두 SHA-256은 `b1c6bf51cd8634304be39f06be87ed92917915d8cc929676885d3e66a562df5f`로 일치했다.
5. core의 세 UUID 파싱을 원래 타입 캐스트로 되돌리자 신규 시험은 **24/27 PASS, 3/27 FAIL**이었다. index는 202, search와 memory delete는 200이 되어 400·하위 호출 0회 계약을 위반했다. 원복 뒤 `cmp`가 성공했고 두 SHA-256은 `2d8d85228b7563dc1fd2af1c275d7d2871588e5fa57fe45884149fa68faef9e7`로 일치했다.

실패 출력도 지우지 않고 아래 로그에 보존한다.

- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-uuid.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-disconnect.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-disconnect-run2.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-core-uuid.log`

## 7. 검증 결과

| 실행 | 결과 |
|---|---:|
| 수정 직후 표적 시험 | **18/18 PASS** |
| 채팅 회귀 fixture 보정 후 관련 5파일 | **56/56 PASS** |
| 첫 정적 4단계 | **2/4 PASS** — typecheck·build PASS, lint 1건과 단위 11건 FAIL |
| 첫 구현 뒤 정적 4단계 재실행 | **4/4 PASS** — 단위 **470/470**, 실패·SKIP·todo 0 |
| 전체 UUID 경로 확장 관련 7파일 | **83/83 PASS** |
| 확장 뒤 최종 정적 4단계 | **4/4 PASS** — 단위 **473/473**, 실패·SKIP·todo 0 |

첫 전체 실행은 새 TCP 시험의 `signal.reason` 타입을 Error로 좁히지 않아 lint가 실패했고, 기존 세 채팅 시험 파일이 제품 DB에는 올 수 없는 `one`·`test`·`session`을 경로 ID로 사용해 단위 시험 11건이 실패했다. 제품 검증을 낮추지 않고 fixture를 유효한 UUID로 바꿨다. 실패 원문은 `next-1-3-static4.log`와 `next-1-3-api-unit-first.log`, 최종 성공은 `next-1-3-static4-rerun.log`에 있다.

실제 TCP 시험은 현재 `registerBigDataRoutes`, 요청 수명 `AbortSignal`, 전역 오류 경계와 임의 루프백 포트를 함께 사용한다. 클라이언트 종료 뒤 error 레벨 로그 **0건**, debug 분류 **1건**을 확인했다. 살아 있는 연결의 합성 `AbortError`와 일반 예외는 각각 500·error 로그 **1건**을 유지했다. UUID GET·POST는 실제 라우트와 전역 오류 경계를 사용해 둘 다 400, DB 조회 0회를 확인했다.

전체 path-param 감사에서 UUID DB 컬럼으로 들어가면서 검증이 없던 나머지 경로는 core의 세 개뿐이었다. 실제 로컬 PostgreSQL과 현재 라우트를 연결한 수정 전 실행은 index/search/memory-delete가 모두 **500**이었다. 수정 후 같은 실행은 모두 **400**이고 라우트 DB 0회, `forget` 0회, retriever 0회였다. 첫 재현 명령은 `tsx --eval`의 CJS 모드에서 top-level await를 사용해 코드 실행 전에 실패했으며, 이 실패도 `next-1-3-core-uuid-head.log`에 남겼다. async IIFE로 고친 재현은 `next-1-3-core-uuid-head-rerun.log`, 수정 후 결과는 `next-1-3-core-uuid-fixed.log`, 확장 게이트는 `next-1-3-static4-expanded.log`에 있다.

## 8. 확인하지 못한 범위와 인접 발견

- 시작 시 사용자용 8791 서버가 내려가 있었으므로 그것을 재기동하거나 브라우저로 다시 확인하지 않았다. 사용자 데이터와 운영 상태를 바꾸지 않았다.
- Fastify 4에서 재현하지 않았고, 다른 OS·원격 프록시의 소켓 종료 형상은 미검증이다.
- 외부 AI API 키·모델 품질·공개 체험판·원격 CI는 사용하거나 확인하지 않았다.
- 감사한 현재 HTTP path-param 중 execution·workspace UUID 경로는 기존 Zod 검증을 사용했고, bigdata는 정수, OAuth provider와 marketplace slug/version은 텍스트 키라 제외했다. 새 라우트가 추가될 때 자동으로 UUID 검증을 강제하는 스키마 생성 체계까지 만든 것은 아니다.
