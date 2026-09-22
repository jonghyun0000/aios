# dev-up pnpm 사전 검사

> NEXT_STEPS 1-5의 완료 기준 사전 등록. 2026-09-22, 수정 전 작성.

## 1. 범위와 최초 재현

- 기준 커밋: `500989f` (`git status`가 깨끗한 상태).
- `git archive`로 꺼낸 HEAD의 `scripts/dev-up.sh` SHA-256은 원본과 fixture가 모두 `7caebcb621f68052144b08a0127eb1b2609f8bd77c8dbe67eaac7b6973641561`로 일치했다.
- 사용자 Docker·Ollama·API·키를 건드리지 않도록 격리 fixture에서 docker는 healthy, Ollama는 모델 1개, API health는 실패하도록 합성했다. 90회 대기는 합성 `seq`·`sleep`로 한 번·무대기로 줄였다. 기존 `/tmp/aios-api.log`를 덮어쓰지 않기 위해 **로그 목적지 한 줄만** fixture의 T7 경로로 바꿨다.
- `pnpm`이 없는 PATH에서 시작기는 postgres·Ollama·키 상태까지 진행하고 API 기동을 시도한 뒤 exit 1로 끝났다. 사용자에게 보인 원인은 `API 서버가 뜨지 않았다 — /tmp/aios-api.log 확인`뿐이었다. 격리된 내부 로그에만 `nohup: pnpm: No such file or directory`가 있었다.

최초 사용자 출력은 `/Volumes/T7/bigdata/verification-reports/next-1-5-head-missing-pnpm.log`에 보존했다. 내부 `aios-api.log`의 정확한 한 줄 `nohup: pnpm: No such file or directory`는 재현 중 직접 확인했으며, 사용자 로그로 오인되지 않도록 fixture와 함께 정리했다.

## 2. 원인

`dev-up.sh`는 `pnpm` 존재를 확인하지 않고, 출력이 T7이 아닌 `/tmp/aios-api.log`로 분리된 백그라운드 subshell 안에서 `nohup pnpm --filter @aios/api dev`를 실행한다. 명령 탐색 실패는 부모 셸에 전달되지 않는다. 부모는 health timeout 뒤 일반 오류만 출력하므로 사용자는 PATH 문제를 서버 장애와 구분할 수 없다.

## 3. 수정 전 완료 기준

아래를 모두 만족해야 1-5를 완료로 바꾼다.

1. 일반 기동에서 `pnpm`을 PATH에서 찾지 못하면 `.env.local`, Docker, Ollama, 키, API 서버를 확인하거나 변경하기 전에 exit 1로 끝난다.
2. stderr에 `pnpm`을 찾지 못했다는 직접 원인, API 서버를 시작하지 않았다는 사실, `AGENTS.md`와 동일한 `export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/local/lib/node_modules/corepack/shims:$PATH"`, `command -v pnpm` 확인 방법을 출력한다. 일반 `API 서버가 뜨지 않았다` 오류로 숨기지 않는다.
3. `--export-only`는 서비스를 시작하지 않으므로 pnpm을 요구하지 않는다. PATH에 pnpm이 있으면 기존 기동 검사를 그대로 진행한다.
4. T7 격리 회귀 시험은 위 세 경로를 실제 bash로 실행하며 사용자 설정·Docker·서버·키를 사용하지 않는다.
5. pnpm 사전 검사 블록을 제거하는 결함 주입에서 신규 시험이 실패하고, 원복 뒤 파일 바이트가 기준 사본과 일치한다.
6. 신규 표적 시험, local-ops, 기본 정적 4단계가 PASS한다. 결과 원문은 T7에 보존한다.
7. 이 작업이 만든 정확한 fixture만 정리한다. push·배포·외부 키·사용자 데이터 변경은 하지 않는다.

## 4. 비범위

- pnpm을 설치하거나 PATH를 자동 변경하지 않는다. 사용자가 복사해 실행할 명령만 안내한다.
- 실제 개발 서버·Docker·Ollama를 재기동하거나 기존 `/tmp/aios-api.log`를 변경하지 않는다.
- `dev-up.sh`의 고정 `/tmp` 로그 위치를 이번 작업에서 재설계하지 않는다. 최초 재현 fixture만 사용자 로그 보호를 위해 T7로 치환했다.

## 5. 수정

- 일반 기동의 첫 비파괴 사전 검사로 `command -v pnpm`을 추가했다. 찾지 못하면 직접 원인과 “API 서버를 시작하지 않았다”는 상태를 stderr에 쓰고 즉시 exit 1로 끝낸다.
- 복구 안내는 `AGENTS.md`와 같은 PATH export 문과 `command -v pnpm` 확인 명령을 그대로 보여 준다. 현재 PATH나 키 값은 출력하지 않는다.
- `--export-only`는 서비스 기동 경로가 아니므로 검사를 건너뛴다. pnpm이 발견된 일반 기동도 기존 설정 검사로 그대로 진행한다.
- 실제 bash로 세 경로를 실행하는 `scripts/dev-up.test.mjs`를 추가했다. 로컬에서는 T7에만 fixture를 만들고, T7이 없는 공개 Linux CI에서는 OS 임시 디렉터리를 쓴다. fixture는 ROOT 계산용 `dirname`과 pnpm 존재 경로의 no-op `pnpm` 외에는 외부 명령을 제공하지 않아 사용자 설정·Docker·Ollama·키·API에 닿으면 시험이 실패한다.
- 신규 시험을 `verify-all local-ops`와 공개 CI의 읽기 전용 경계 시험에 넣었다.

## 6. 결함 주입

- 고정본 `dev-up.sh`를 T7에 보관한 뒤 pnpm 사전 검사와 안내 블록만 제거했다.
- 신규 시험은 **2/3 PASS, 1/3 FAIL**이 됐다. 빠진 검사를 담당하는 첫 시험이 pnpm 직접 원인을 찾지 못하고 fixture의 `설정이 없다`를 받아 실패했다. 나머지 `--export-only`·pnpm 존재 경로는 그대로 통과했다.
- `apply_patch`로 원복한 뒤 기준 사본과 `cmp`가 일치했다. 두 SHA-256은 모두 `1c1334d778ac2fef94d1067f5405956a8fa0d0e17a78c66552637e35a6091988`이었다.

실패 원문은 `/Volumes/T7/bigdata/verification-reports/next-1-5-fault-preflight.log`에 있다.

## 7. 실행 결과

| 실행 | 결과 |
|---|---:|
| 수정 전 HEAD 격리 시작 | exit **1**, postgres·Ollama·키 확인 뒤 API 기동 시도, 사용자에게 일반 오류만 출력 |
| 수정 후 실제 제한 PATH CLI | exit **1**, pnpm 직접 원인·미기동 상태·정확한 PATH·확인 명령 출력, 서비스 호출 없음 |
| 신규 bash 회귀 시험 | **3/3 PASS** |
| `verify-all local-ops` | **1/1 PASS**, 실패·BLOCKED·SKIP 0 |
| 기본 정적 4단계 | **4/4 PASS** — 단위 **475/475**, 실패·SKIP·todo 0 |

고정 CLI 원문은 `next-1-5-fixed-missing-pnpm.log`, 신규 시험은 `next-1-5-targeted-final.log`, local-ops 보고서는 `verify-1790075611962-6736ba42-9bbf-4319-af37-dcd8e84c00e8.json`, 최종 정적 보고서는 `verify-1790075644591-c265ff8a-9c42-401d-be53-636c2bb558e1.json`에 있다.

## 8. 확인하지 못한 범위

- 실제 pnpm이 없는 사용자 셸에서 Docker·Ollama까지 포함한 90초짜리 기존 경로는 고정본에서 다시 실행하지 않았다. 격리 HEAD fixture로 동일 분기와 내부 명령 탐색 실패를 재현했다.
- 실제 개발 서버·Docker·Ollama·`.env.local`·키 파일은 사용하거나 변경하지 않았다. 정상 pnpm PATH의 전체 `dev-up.sh` 기동도 이번 변경 뒤 재실행하지 않았다.
- 공개 Linux CI에는 시험을 추가했지만 push하지 않았으므로 원격 실행 결과는 없다. 다른 셸·다른 OS의 실사용도 미검증이다.

## 9. 정리

- 작업 중 만든 `/Volumes/T7/bigdata/tmp/aios-head-1-5-500989f`, `/Volumes/T7/bigdata/tmp/aios-1-5-mutation-500989f`만 정확한 경로로 정리했고 둘 다 사라졌음을 확인했다.
- 동적 `dev-up-preflight-*` 시험 디렉터리는 각 시험 종료 훅이 정리했으며 잔존 경로가 없었다. 64991·8790·8791의 새 리스너와 작업 경로를 가리키는 프로세스·고아 esbuild도 없었다.
- 검증 로그만 `/Volumes/T7/bigdata/verification-reports/`에 보존했다. push·배포·외부 키·사용자 데이터 변경은 하지 않았다.
