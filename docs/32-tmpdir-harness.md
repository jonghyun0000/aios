# 검증 하네스 tmpdir 정규화

> NEXT_STEPS 1-2의 완료 기준 사전 등록. 2026-09-22, 수정 전 작성. 구현·검증 커밋 `ab31904`.

## 1. 범위와 최초 재현

- 기준 커밋: `9609e77` (`git status`가 깨끗한 상태).
- macOS의 임시 경로는 `/tmp` 또는 `/var/folders/...`로 보이지만 `realpath`는 `/private/tmp` 또는 `/private/var/folders/...`다.
- `git archive HEAD`로 꺼낸 `packages/tools/src/builtin/fs.ts`에 대해 임시 폴더를 작업공간으로 넘기면 `read_file`이 `workspace root must not contain symbolic links`로 실패했다.
- `TMPDIR`를 설정하지 않고 실행한 phase4는 **39/44**였다. 파일 쓰기·읽기·승인 쓰기·큰 출력·감사 상태 5개가 같은 원인으로 실패했다.
- 같은 조건의 phase7은 겉으로는 **35/35**였지만 유효한 성공이 아니다. `read_file`이 위 오류를 반환했는데도 모델이 질문에 있던 값 `3`을 추측했고, 기존 `\b3\b` 단언이 이를 성공으로 셌다.
- 환경을 로딩하지 않은 별도 첫 실행의 `no_providers`는 tmpdir 결함이 아니라 하네스 실행 전제이므로 이 작업의 수정 대상에서 제외한다.

실행 원문은 `/Volumes/T7/bigdata/verification-reports/next-1-2-*.log`에 둔다.

## 2. 원인

`mkdtemp(join(tmpdir(), ...))`가 반환한 문자열 경로를 그대로 `projectRoot`로 쓴다. 파일 도구의 `safeJailPath`는 작업공간 루트 자체에 심볼릭 경로가 섞이지 않았는지 `realpath(root) === root`로 검사하므로 macOS의 `/tmp`·`/var` 별칭을 안전하게 거부한다. 제품의 jail을 완화할 문제가 아니라 검증 하네스가 실제 경로를 만들어 넘겨야 하는 문제다.

## 3. 수정 전 완료 기준

아래를 모두 만족해야 1-2를 완료로 바꾼다.

1. 하네스 공용 임시 폴더 생성기는 부모를 먼저 `realpath`로 정규화하고, 자신이 만든 정확한 경로만 정리한다.
2. 합성 심볼릭 부모를 사용하는 단위 시험에서 생성된 루트가 정규 경로임을 확인한다. 정규화를 제거하는 결함 주입에서 이 시험이 실제로 실패하고, 원복 뒤 파일이 정확히 같음을 `cmp`로 확인한다.
3. `TMPDIR` 설정 없이 phase4가 전체 PASS 한다.
4. `TMPDIR` 설정 없이 phase7이 전체 PASS 하고, prompt-injection 검사가 `read_file`의 성공과 fixture 본문을 별도 단언한다. 모델 경로가 있으므로 3회 반복 결과를 모두 남긴다.
5. 같은 임시 작업공간 패턴을 쓰는 phase5·phase6·`s2-scenario`를 공용 생성기로 바꾼다. 각 하네스를 우회 없는 환경에서 실행해 tmpdir 영향 여부를 기록한다. 이 1회 실행은 경로 회귀만 판정하며 모델 품질의 개선 근거로 쓰지 않는다.
6. phase6의 파일 도구 부하는 소프트 오류를 성공 표본으로 세지 않는다. `ToolResult.ok`와 예상 본문을 검사해 실패를 `load()` 오류로 올린다.
7. 기본 정적 4단계 `node scripts/verify-all.mjs`가 PASS 한다. 결과 원문은 T7의 검증 보고서 디렉터리에 보존한다.
8. 새 하네스가 만든 임시 폴더·프로세스만 정확한 경로/PID로 정리하고, 고아 esbuild가 0개임을 확인한다.

## 4. 비범위

- jail의 심볼릭 링크 방어를 약화하지 않는다.
- 로컬 모델의 prompt-injection 방어 품질을 이 작업으로 개선했다고 주장하지 않는다.
- 외부 AI API 키, phase8, `--legacy-full`, 운영 복원, 기존 Docker 볼륨 삭제를 사용하지 않는다.

## 5. 실행 결과

### 결함 주입

- 공용 생성기의 부모 정규화만 제거했을 때는 생성 뒤 `realpath`가 한 번 더 있어 시험이 계속 통과했다. 이것은 남은 방어선이 동작한 결과이며 실패 검출로 세지 않았다.
- 부모와 생성 결과의 정규화를 모두 제거하자 새 단위 시험이 **0/1**로 실패했고, 반환 경로의 `alias`와 실제 경로의 `actual` 차이를 검출했다.
- 두 정규화를 원복한 뒤 `cmp`가 0으로 끝났고 SHA-256 두 값이 모두 `3d3d9ffd74d043644e0d5ef5a179c823d3b6554bc0a9edb178772382a8c7a7a1`로 일치했다. 원복 후 시험은 **1/1 PASS**였다.
- 제품 jail의 기존 링크 방어 시험도 **1/1 PASS**했다. 제품 방어 규칙은 수정하지 않았다.

### 하네스

모든 실행은 `TMPDIR`를 설정하지 않았고 외부 AI API 키를 비운 상태에서 로컬 모델만 사용했다.

| 실행 | 결과 | 1-2 판정 |
|---|---:|---|
| phase4 최초 | 39/44 FAIL | tmpdir 충돌 재현 |
| phase4 수정 후 | **48/48 PASS** | 파일 도구와 정리 경로 정상 |
| phase7 최초 | 35/35 거짓 PASS | 실제 `read_file` 실패를 숫자 `3` 추측이 가림 |
| phase7 수정 후 3회 | **36/36, 36/36, 36/36 PASS** | 매회 `sec.injection_fixture_read` 포함 |
| phase6 | **16/16 PASS** | 파일 도구 실제 본문 **1000/1000**, p95 2ms |
| `s2-scenario` | **23/23 PASS** | `/private/tmp` 작업공간에서 생성→결함→수리→빌드 관통 |
| phase5 | 29/31 FAIL | 작업공간·파일 도구·최종 파일은 정상. 아래 별도 기존 결함 2건 |
| 정적 4단계 재실행 | **4/4 PASS** | 단위 **465/465**, 실패·SKIP·todo 0 |

첫 정적 실행은 원인 귀속을 위해 저장소 아래에 둔 `.tmp/head-1-2`가 린트 대상에 들어가 실패했다. 그 정확한 시험 경로를 저장소 밖 T7 임시 폴더로 옮긴 뒤 같은 코드로 재실행해 4/4를 확인했다. 코드 실패로 세거나 기록에서 지우지 않는다.

## 6. 이번 작업과 분리한 기존 결함

phase5의 작업공간은 `/private/tmp/aios-e2e-6szOdO`였고 `write_file`·읽기 전 수정·최종 파일 생성·감사 기록은 정상이라 tmpdir 결함은 재현되지 않았다. 전체 실패 2건은 다음과 같다.

1. 로컬 모델이 첫 `subtotal` 구현에 named `export`를 빠뜨려 독립 실행이 실패했다. 이후 작업은 진행됐지만 이 1회 결과를 모델 품질 판단에 사용하지 않는다.
2. `step8.context_assembled`가 현재 프롬프트의 `# Reference excerpts` 대신 과거 문자열 `Relevant code`를 찾고 있어, facts 1개와 RAG chunk 4개가 실제 조립됐는데도 실패했다. 1-2 범위에서 단언을 조용히 바꾸지 않고 별도 기존 결함으로 남긴다.

실행 원문:

- `/Volumes/T7/bigdata/verification-reports/next-1-2-reproduce-phase4.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-phase4-fixed.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-phase7-fixed-run1.log`~`run3.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-phase5-fixed.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-phase6-fixed.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-s2-scenario-fixed.log`
- `/Volumes/T7/bigdata/verification-reports/next-1-2-static4.log`(실패)과 `next-1-2-static4-rerun.log`(성공)
