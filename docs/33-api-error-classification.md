# API 오류 분류

> NEXT_STEPS 1-3의 완료 기준 사전 등록. 2026-09-22, 수정 전 작성.

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

## 4. 비범위

- 모든 데이터베이스 오류를 4xx로 낮추지 않는다. 입력 UUID는 라우트 경계에서 검증한다.
- 단순히 오류 이름이 `AbortError`라는 이유만으로 숨기지 않는다. 실제 요청 연결 종료 상태가 함께 확인되어야 한다.
- 사용자용 8791 서비스의 재기동이나 운영 상태 변경은 이 작업에 포함하지 않는다.

## 5. 수정

- 전역 오류 처리를 `api-error-handler.ts`로 분리해 제품 서버와 실제 라우트 시험이 같은 계약을 사용하게 했다.
- 연결 종료는 **소켓이 실제로 종료된 상태**이면서 `AbortError`, `ABORT_ERR`, `ECONNRESET`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE` 중 하나일 때만 debug로 분류하고 응답을 다시 쓰지 않는다.
- 살아 있는 연결의 `AbortError`와 일반 예외는 계속 500과 error 로그를 만든다. 단순 오류 이름만으로 서버 장애를 숨기지 않는다.
- 메시지 GET·POST가 공용 `SessionParamsSchema`의 UUID 검증을 DB 조회 전에 사용한다.
- 기존 채팅 시험의 `one`·`test`·`session` 합성 경로 ID는 새 제품 계약을 우회하지 않도록 유효한 서로 다른 UUID fixture로 바꿨다.

## 6. 결함 주입

1. 두 메시지 라우트의 UUID 파싱을 원래 타입 캐스트로 되돌리자 신규 시험은 **13/15 PASS, 2/15 FAIL**이었다. GET은 200, POST는 404가 되어 기대한 400과 DB 0회 계약을 위반했다.
2. 연결 종료 분기를 제거하자 실제 TCP 시험은 **2/3 PASS, 1/3 FAIL**이었고 level 50 로그 **1건**을 검출했다.
3. UUID 파일 원복 뒤 `cmp`가 성공했고 두 SHA-256은 `14498a3f30e3bbb89e4ab925fba1b4a029d7fb5f21da22e73515c1814dd7e63b`로 일치했다.
4. 첫 연결 종료 원복의 `cmp`는 코드가 아니라 파일 끝의 빈 줄 1개 차이로 실패했다. 이를 성공으로 세지 않고 한 줄 개행을 기준으로 고정한 뒤 같은 결함 주입을 다시 실행했다. 두 번째 원복의 `cmp`가 성공했고 두 SHA-256은 `b1c6bf51cd8634304be39f06be87ed92917915d8cc929676885d3e66a562df5f`로 일치했다.

실패 출력도 지우지 않고 아래 로그에 보존한다.

- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-uuid.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-disconnect.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-3-fault-disconnect-run2.log`

## 7. 검증 결과

| 실행 | 결과 |
|---|---:|
| 수정 직후 표적 시험 | **18/18 PASS** |
| 채팅 회귀 fixture 보정 후 관련 5파일 | **56/56 PASS** |
| 첫 정적 4단계 | **2/4 PASS** — typecheck·build PASS, lint 1건과 단위 11건 FAIL |
| 최종 정적 4단계 | **4/4 PASS** — 단위 **470/470**, 실패·SKIP·todo 0 |

첫 전체 실행은 새 TCP 시험의 `signal.reason` 타입을 Error로 좁히지 않아 lint가 실패했고, 기존 세 채팅 시험 파일이 제품 DB에는 올 수 없는 `one`·`test`·`session`을 경로 ID로 사용해 단위 시험 11건이 실패했다. 제품 검증을 낮추지 않고 fixture를 유효한 UUID로 바꿨다. 실패 원문은 `next-1-3-static4.log`와 `next-1-3-api-unit-first.log`, 최종 성공은 `next-1-3-static4-rerun.log`에 있다.

실제 TCP 시험은 현재 `registerBigDataRoutes`, 요청 수명 `AbortSignal`, 전역 오류 경계와 임의 루프백 포트를 함께 사용한다. 클라이언트 종료 뒤 error 레벨 로그 **0건**, debug 분류 **1건**을 확인했다. 살아 있는 연결의 합성 `AbortError`와 일반 예외는 각각 500·error 로그 **1건**을 유지했다. UUID GET·POST는 실제 라우트와 전역 오류 경계를 사용해 둘 다 400, DB 조회 0회를 확인했다.

## 8. 확인하지 못한 범위와 인접 발견

- 시작 시 사용자용 8791 서버가 내려가 있었으므로 그것을 재기동하거나 브라우저로 다시 확인하지 않았다. 사용자 데이터와 운영 상태를 바꾸지 않았다.
- Fastify 4에서 재현하지 않았고, 다른 OS·원격 프록시의 소켓 종료 형상은 미검증이다.
- 외부 AI API 키·모델 품질·공개 체험판·원격 CI는 사용하거나 확인하지 않았다.
- 조사 중 `core.ts`에도 UUID로 보이는 경로 ID를 타입 캐스트만 하는 인접 경로가 보였다. 1-3의 사전 등록 범위인 메시지 GET·POST와 섞어 조용히 넓히지 않고 별도 위험으로 확인한다.
