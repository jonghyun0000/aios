# 2-1 Linux CI 통합

## 수정 전 기록 — 2026-09-25

기준 HEAD `217d2f2`, 작업 트리는 깨끗했다. HEAD의 CI를 실행 가능한 검사로 읽었을 때 `services=false`, `integration=false`, `migrations=false`였다. 기존 CI는 실제 서비스 통합을 의도적으로 제외했으므로 이번 작업은 그 공백을 채운다.

## 사전 완료 기준

1. GitHub Linux 서비스 컨테이너 Postgres(pgvector)·Redis·Ollama를 사용하며 전체 잡은 20분 이내다. 외부 AI 키가 필요 없어야 한다.
2. 매 실행 새로운 무작위 이름의 DB와 작업 폴더를 만들고 실제 `scripts/migrate.mjs`로 모든 마이그레이션을 적용한다. 기존 DB에 마이그레이션하지 않는다.
3. 실제 `createContext`·`buildServer`를 루프백 HTTP에 기동하고 `/readyz`, 대화 SSE, PostgreSQL 메시지 저장, Redis 대화 저장을 확인한다. 대화는 새 세션 3개에서 반복하고 응답 존재·단일 정상 종료를 검사한다. 품질 점수를 매기지 않는다. Wilson 95% 구간도 기록한다.
4. 실제 임베딩 1024차원과 PostgreSQL vector 왕복을 확인한다. CI 모델은 소형 `qwen2.5:0.5b`와 `bge-m3`로 구성한다. 다운로드는 잡 시간에 포함하며 최초에는 캐시 없이 측정한다.
5. 고정된 `write_file` 호출을 제품 ExecutionService에 넣고 HTTP 승인 경로로 결정한다. 승인 전 파일 불변, 승인 후 실제 파일·DB의 SHA-256 일치, 중복 승인 거부와 복구를 확인한다. 모델의 도구 선택 정확도는 검증 범위가 아니다.
6. `0005_execution_safety.sql`을 제외한 별도 마이그레이션 복사본과 새 DB를 사용하는 결함 주입에서 같은 통합 검사 프로세스가 스키마 누락으로 실패해야 한다. 원본 파일은 변경하지 않고 복사 전후 해시를 비교한다.
7. 관련 검사와 정적 4단계를 통과하고, 로컬 결과와 원격 Linux 결과를 구분한다. 원격 실행은 새 커밋의 push 승인 후 확인한다. 실제 원격 성공 전 §5의 상태는 진행으로 유지한다.

## 근거의 범위

입증 대상은 깨끗한 Linux에서 문서화된 서비스로 핵심 경로를 실행하는 것이다. macOS·T7·Colima 재현성, 8B 모델의 품질, 별도 API 프로세스의 기동·종료, Docker 명령 실행·워커·백업은 이 잡의 범위 밖이다. 두 번째 Mac 근거나 점수 가산으로 쓰지 않는다.

서비스 연결 방식은 [GitHub 공식 문서](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers), 소형 모델 선택은 [Ollama 모델 목록](https://registry.ollama.com/library/qwen2.5)을 참고했다.

## 구현과 재현 명령

`.github/workflows/ci.yml`에 `integration` 잡을 추가했다. Postgres 16/pgvector·Redis 7·Ollama 0.11.10(linux/amd64 digest 고정)을 사용한다. 외부 키를 전달하지 않으며, 서비스 컨테이너의 최초 모델 다운로드에 8분·통합 명령에 10분·전체 잡에 20분 상한을 둔다. 모델 태그의 실제 digest는 `ollama list` 로그에 남는다. 현재 모델 캐시는 사용하지 않는다.

`scripts/verify-ci-integration.mjs`는 루프백 연결만 받고 `aios_ci_<무작위 UUID>` DB 두 개를 새로 만든다. 하나에는 0005를 제외한 복사본을 적용하고 같은 통합 검사 프로세스가 실제 `execution_actions` 질의에서 PostgreSQL `42P01`로 실패하는지 확인한다. 다른 DB에는 원래 마이그레이션 러너를 실행한 뒤 정상 검사를 수행한다. 자식 환경은 허용한 설정만 조립하므로 개발용 `.env`와 외부 키를 상속하지 않는다. 종료 코드 0과 완료 요약의 3/3을 모두 요구한다.

`apps/verify/src/ci-integration.ts`는 실제 컨텍스트·HTTP 서버를 조립한다. 도구 제안만 고정 입력하고 승인 결정은 실제 HTTP 라우트로 전송한다. PostgreSQL 저널과 실제 파일을 독립적으로 읽어 SHA-256을 비교한다. 복구 후 원래 본문과 DB 상태도 확인한다.

로컬 실행은 아래와 같다. `CI_DATABASE_URL`은 CREATE DATABASE 권한이 있는 로컬 관리자 연결이며 연결 대상 DB 자체는 변경하지 않는다. Redis에는 시험 전용 인스턴스/DB를 지정한다.

```sh
AIOS_CI_INTEGRATION=1 \
CI_DATABASE_URL=postgresql://aios:aios@127.0.0.1:5432/aios \
CI_REDIS_URL=redis://127.0.0.1:6379/15 \
CI_OLLAMA_URL=http://127.0.0.1:11434 \
CI_ARTIFACT_ROOT=/Volumes/T7/bigdata/tmp \
node scripts/verify-ci-integration.mjs
```

## 실패 이력과 기존 결함

로그는 모두 `/Volumes/T7/bigdata/verification-reports/` 아래에 보존한다.

- `ci-integration-first.log`: tsx CLI가 T7에 IPC Unix 소켓을 만들려다 `ENOTSUP`. 검사 진입점을 단일 Node `--import` 로더로 바꿔 소켓·래퍼 필요를 없앴다.
- `ci-integration-second.log`: 누락 스키마는 정상 검출했지만 명시적 로컬 모델 선택이 `unknown_model`로 실패했다. 기존 `AiRouter.rank`가 동적 카탈로그 대신 정적 `findModel`을 읽는 원인을 확인했고, 직접 `rank({model:"qwen3:8b"})` 호출로도 재현했다. 이번에는 모델 하나만 등록한 자동 선택 경로를 검증하며 제품 결함을 고쳤다고 주장하지 않는다.
- `ci-integration-third.log`: SSE 응답 이후 검사기가 DB의 JSONB `{text,toolCalls}`를 문자열과 비교해 실패했다. 실제 저장 형식의 `content.text`를 비교하도록 검사기를 수정했다.
- `ci-integration-fourth.log`: 핵심 검사는 모두 통과했으나 Redis 연결 때문에 프로세스가 남아 종료 코드까지는 실패다(소유한 PID에 SIGTERM). 제품 `main.ts`처럼 정리 후 명시적 종료를 적용했다. 레거시 WS에 구독 연결 해제가 없고 큐 연결도 남을 수 있어 자연 종료 검증으로 계산하지 않는다.

## 로컬 검증 결과

- CI용 qwen2.5:0.5b: `ci-integration-final-small.log`에서 대화 **3/3**, 마이그레이션 결함 검출·1024차원 임베딩·DB/Redis 저장·승인·해시·복구·종료 코드 **0**을 확인했다. 모델 digest는 `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67`, bge-m3는 `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`다. 3/3의 Wilson 구간은 아래와 같다.
- 최종 qwen3:8b: `ci-integration-final-8b.log`에서 누락 마이그레이션 검출·대화 **3/3**·DB/Redis 저장·1024차원 임베딩과 pgvector 왕복·파일 승인·해시·중복 거부·복구·종료 코드 **0**을 확인했다. 채팅 응답 존재 3/3의 Wilson 95% 구간은 **43.85%~100%**이며 품질·일반 성공률의 증거가 아니다.
- 마이그레이션 원본 전후 SHA-256: `b849e900b1cd71d5942b59786fcba05ea0089e1d0ef907c3412450c70f14b60d`. 원본을 수정하는 결함 주입이 아니므로 원복은 필요 없으며, 복사본만 정리했다.
- 정적 **4/4 PASS**, 이식 가능 단위 **475/475**. `ci-integration-static-final.log`와 `verify-1790263333099-08567189-624d-4f0f-8a84-ed35c8d05cf8.json`에 기록했다. YAML 파싱과 `git diff --check`도 통과했다.
- 로컬 Ollama는 0.32.15이다. CI의 고정 0.11.10 컨테이너·Linux CPU·다운로드 포함 20분 조건은 원격에서 확인해야 한다.

## 정리와 남은 범위

이번 실행에서 CREATE에 성공한 DB와 생성한 임시 폴더만 제거한다. Redis 대화·이벤트·지연 작업은 생성한 세션 ID로만 정리한다. 최초 실패 실행이 남긴 이벤트 4개도 해당 로그의 세션 ID 5개로 확인해 정리했다. 기존 DB 행·사용자 작업 폴더·컨테이너는 변경하지 않았다.

소형 모델 qwen2.5:0.5b 약 398MB를 T7 모델 저장소에 추가했다. 다음 검증에서 재사용한다. 아래 원격 실패로 로드맵 2-1은 **진행**이다.

## 첫 원격 실행과 후속 완료 기준 — 2026-09-25

사용자 승인 후 `ddf1c73`을 push했다. [실행 36022205434](https://github.com/jonghyun0000/aios/actions/runs/36022205434)에서 audit·verify는 성공했지만 integration은 88초 만에 실패했다. 모델 다운로드·마이그레이션 누락 검출은 성공했으며 정상 대화 첫 요청이 Ollama HTTP 400으로 거부됐다. 원본 로그는 T7의 `verification-reports/ci-integration-remote-36022205434.log`에 보존했다. 대화 3회·승인·복구는 원격 PASS가 아니다.

원인 귀속: 로컬 성공 환경은 Ollama 0.32.15인데 새 CI가 0.11.10을 선택했다. 기존 어댑터는 빠른 대화에 `reasoning_effort:"none"`을 전송한다. [0.11.10 변환 코드](https://github.com/ollama/ollama/blob/v0.11.10/openai/openai.go)는 이를 문자열 Think로 전달하고 [서버 코드](https://github.com/ollama/ollama/blob/v0.11.10/server/routes.go)는 문자열 Think를 일반 모델에서 거부한다. 로그 본문은 가려져 있어 구체적인 오류 메시지는 관측하지 못했지만, 소스상 요청 호환성 불일치가 확인됐다. 제품 코드의 신규 회귀가 아니라 CI 버전 선택의 문제로 분류한다.

수정 전 기준: CI만 로컬 검증 버전 0.32.15의 linux/amd64 digest로 고정하고 기존 단언·결함 주입을 그대로 유지한다. 정적 4단계와 로컬 소형 모델 통합 검사를 다시 실행한다. 원격의 동일 경로 성공·20분 조건은 새 push 승인 후 확인하며 그 전에는 완료로 바꾸지 않는다. 최초 실패가 버전 정렬 전의 음성 근거이며, 마이그레이션 결함 주입도 계속 실행한다.

수정 및 재검증: `docker manifest inspect ollama/ollama:0.32.15`로 linux/amd64 digest `sha256:ab903927dcb081c6d3780b54a7b6de4fda6a65cb9799e4f047a34ba9511b9c78`을 확인하고 CI에 고정했다. [0.32.15 변환 코드](https://github.com/ollama/ollama/blob/v0.32.15/openai/openai.go)는 `none`을 불리언 false로 변환한다. 앞의 구현 설명 중 0.11.10은 최초 실행 당시 버전이며 현재 고정은 0.32.15다. 제품 코드·단언은 바꾸지 않았다.

- `ci-ollama-alignment-local.log`: 누락 마이그레이션 검출, 대화 **3/3**, 임베딩·승인·해시·복구·원본 마이그레이션 지문 일치, 종료 **0**. 로컬 Ollama를 사용했으며 새 Linux 이미지를 실행한 결과는 아니다.
- `ci-ollama-alignment-static.log`: 정적 **4/4**, 단위 **475/475**, 실패·skip **0**. 구조화 보고서 `verify-1790264956986-ba4f39df-304f-4b7a-8a31-54447fd7b834.json`. YAML과 고정 digest 검사도 통과했다.
- 이번 검사 임시 폴더와 고아 esbuild 없음. 생성한 시험 DB·Redis 기록은 기존 하네스의 ID 제한 정리로 제거했다. 사용자 데이터·서비스는 유지했다.
- 원격 재실행은 새 수정 커밋의 push 승인 대기다. 최초 실패를 성공으로 덮지 않으며 단계 2-1은 진행이다.
