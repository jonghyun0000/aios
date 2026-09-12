# 검증 명령의 안전 경계와 릴리스 근거

2026-09-12. 기존 83점 이후의 실제 제품 보완 작업이다. 점수는 [고정 평가표](22-project-scorecard.md)를 따르며 이 문서 작성만으로 올리지 않는다.

## 발견한 거짓 성공과 위험한 기본값

기존 `node scripts/verify-all.mjs typo-that-must-not-pass`를 실행하면 실제 검사가 하나도 없는데 `VERIFY: PASS — 0 passed`와 종료 코드 0이 나왔다. 오타를 검증 성공으로 오인할 수 있는 실제 결함이다. 또한 인자 없는 실행에 컨테이너·시험 DB 정리 단계가 자동 포함됐다.

수정 후:

- 인자 없음은 `typecheck lint unit build`만 실행한다. DB 초기화·모델 호출·컨테이너 정리 단계는 기본값에 없다.
- 모르는 단계/옵션·중복·빈 카탈로그는 자식 명령 실행 전 종료 코드 2로 거부한다.
- `--help`와 `--list`는 실행 없이 지원 단계와 위험 표시를 보여준다.
- `phase8` 또는 `--legacy-full`에는 `--allow-destructive-phase8`이 추가로 필요하다. 이 옵션은 안전이나 사용자 승인 자체를 보장하지 않는다. 시험 대상의 격리와 삭제 범위를 사용자가 확인해야 한다.
- 0개 검사·일부 SKIP·차단은 `INCOMPLETE`/종료 코드 2다. 실패는 `FAIL`/1, 선택한 단계 전체 통과만 `PASS`/0이다.
- 검사 전후 코드·설정·의존성 잠금 파일·시험 파일 지문을 비교한다. 중간에 바뀌면 `SOURCE_CHANGED`/2이며 현재 버전의 PASS로 쓰지 않는다. 설명 문서만 제외하고 앱 내부 Markdown 템플릿은 포함한다.

## 재현 명령

```bash
pnpm verify --list
pnpm verify
pnpm verify typecheck lint unit local-ops build --report
node --test scripts/verification-policy.test.mjs
```

`--report`는 연결된 T7의 `bigdata/verification-reports`에 고유 파일을 만든다. 시작/종료 시간, 코드 지문 전후, 선택된 단계의 실제 상태만 기록하며 API 키·환경 값·모델 원문·원본 오류 로그는 넣지 않는다. 보고서는 선택하지 않은 시험이나 다른 장비의 결과를 증명하지 않는다.

정책·보고서 검사 14개가 통과했다. 실제 CLI 오타는 수정 전 exit0/PASS0, 수정 후 자식 실행 전 exit2로 바뀌었다. 보호 없는 phase8과 구형 전체는 실행되지 않음을 확인했다. 별도 소스 복사본에서는 자식 검사 명령만 대역으로 두고 실제 소스 바이트를 바꿔, 자식 종료0이어도 `SOURCE_CHANGED`/2가 되는 것을 확인했다. 이 대역 시험을 실제 빌드 통과로 세지 않는다. 보고서는 링크 경로를 거부하고 임의 환경/원문 필드를 저장하지 않는 시험을 포함한다. 실제 파괴 단계는 실행하지 않았다.

`durability-local`은 `AIOS_DURABILITY_TEST=1`과 로컬 DB 생성 권한이 있어야 실행한다. `context-live`는 `AIOS_CONTEXT_PERSISTENCE_TEST=1`과 로컬 DB/Redis 설정, 실제 사용자용 API가 필요하며 자신이 새로 만든 합성 대화만 생성·저장·휴지통 이동한다. 사전조건이 없으면 차단이며 PASS가 아니다. URL의 겉 호스트가 localhost여도 pg의 `?host=`가 외부 호스트로 바꾸는 결함을 네트워크 없이 재현했고, 시험용 연결 주소의 쿼리·fragment를 거부하도록 보완했다.

## 재현 가능한 도구와 CI

Node 요구 조건을 시작 안내와 같은 22 이상으로 맞추고, 루트의 직접 pnpm 의존성을 `packageManager` 및 CI와 동일한 9.12.0으로 정렬했다. 실행 경로에 따라 다른 pnpm 버전을 사용하던 불일치를 없앤다. 접근성 회귀용 axe-core는 4.10.3으로 고정했다.

진단은 호출한 셸에서 실제로 먼저 선택되는 pnpm을 확인한다. 이번 Codex 도구의 PATH 앞에 있는 알 수 없는 fallback wrapper에서는 `unknown`을 반환했고, 이를 실행하거나 뒤의 명령으로 건너뛰어 성공 처리하지 않았다. 사용자 시작기와 같은 PATH에서는 설치된 Corepack의 pnpm 9.12.0 메타데이터와 전체 준비물 14/14를 확인했다. 진단의 안전 검사를 완화하지 않았으며, 이 차이는 다른 Mac의 설치 성공 근거가 아니다.

CI 동작 도구는 공식 릴리스 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0), [pnpm/action-setup v6.1.0](https://github.com/pnpm/action-setup/releases/tag/v6.1.0)의 실제 커밋에 고정했다. 이 도구들의 실행 환경은 Node 24, 제품 검증에 설치하는 Node는 22로 구분한다. `contents: read`를 유지하고 checkout 자격증명을 후속 코드에 남기지 않는다. 클라우드 배포나 패키지 게시 권한은 추가하지 않는다.

## 단계 수와 실제 단언 수를 구분한다

교차 검토에서 자식 명령의 종료 코드만으로는 Vitest 내부의 검사 0개/전부 SKIP을 알 수 없다는 추가 문제가 확인됐다. 이제 `unit`, `durability-local`, `index-local`은 패키지별 이번 실행 JSON의 실제 assertion 상태와 합계가 일치하는지 검사한다. 검사 0개·선택 파일 누락·내부 SKIP/TODO·불완전 결과는 전체 PASS가 아니며, 옛 성공 JSON을 재사용하지 않는다.

기본 `unit`은 CI와 동일한 **이식 가능한 명시 범위**다. T7/실제 DB가 필요한 API 5개 파일은 처음부터 제외하고 이유를 보고서에 적는다. 독립 단위 시험이 없는 5개 패키지도 통과 수에 넣지 않으며, 그곳에 시험 파일이 생기면 정책 갱신 없이 조용히 생략하지 않는다. 실제 T7 색인은 `index-local`, 승인·복구 새 DB 및 다중 프로세스는 `durability-local`로 따로 실행한다. 타입 검사/빌드는 시험 개수가 아닌 `kind=command`, 단위 검사 결과는 `kind=vitest`로 구분한다.

소스 지문은 **검사 전후 경로·내용의 차이**를 확인한다. 검사 중 수정했다가 같은 바이트로 되돌린 경우나 실행 권한만 바꾼 경우까지 탐지하는 감시 장치는 아니다. 최종 후보 코드를 동결하고 검사하며, 보고서의 소스 지문과 실제 커밋을 함께 추적한다.

## 동결한 최종 후보의 로컬 검증

2026-09-12 19:50 KST 이후, 모든 실행 코드와 시험 파일을 동결한 상태에서 `typecheck lint unit local-ops durability-local index-local build --report`의 **7단계가 모두 PASS**였다. 실제 단위는 **450/450**, 격리 실행 내구성은 **25/25**, T7 색인은 **1/1**이며 각 범위의 FAIL/SKIP/TODO는 0이다. 운영·백업·패키지 및 검증기 자체 결함 주입은 별도 `local-ops` 명령으로 통과했다. 선택하지 않은 로컬 시험을 전체 통과 수에 포함하지 않았다.

- 보고서: `/Volumes/T7/bigdata/verification-reports/verify-1789210283045-512b8ff4-4aaa-4fcd-b505-8b23616a6381.json`
- 검사 전후 동일 코드 지문: `25cbbe0fca9fbab77efbbfbd547cd71e51c4b1510e556f96132565f90b88dfae`
- 앞선 후보 검사는 각 명령이 성공했어도 검사 중 코드 변경을 감지해 `SOURCE_CHANGED`/2였다. 이를 최종 PASS로 재사용하지 않았다.

웹 코드를 동결한 전체 브라우저 회귀는 **126개 중 123 PASS / 0 FAIL / 3 해당 없음**, 재시도·flaky·전역 오류 0, 149.35초였다. 3개는 모바일 전용 검사의 desktop 실행이며 같은 항목의 mobile 검사는 통과했다. 실제 사용자용 API를 이용하는 흐름과 합성 API/WS로 실패를 주입하는 흐름이 섞여 있다. 모든 123개를 실제 DB·모델·파일 시험이라고 부르지 않는다. 보고서는 `/Volumes/T7/bigdata/tmp/release90-browser-85pcF1/report.json`이며 별도 접근성 36개와 일부 중복이 있으므로 합산하지 않는다.

이후 최신 프롬프트 빌드로 사용자 시작기를 통해 정상 종료·재시작했다. 시작 시각 `2026-09-12T10:52:09.581Z`, instance `2912bba6-bfd6-4718-84cd-1fdd7ad54e93`, 새 빌드 7,723ms, API·worker·Postgres·Redis ready를 확인했다. 기존 프로세스의 정상 종료와 잠금 해제 후 새 API가 같은 workspace 소유권을 얻었다. 실제 브라우저 재열기·입력창·사이드바·오류 콘솔도 확인했다. 1280×577 화면의 최신 캡처는 `/Volumes/T7/bigdata/tmp/aios-release90-feMAI9/final-chat.png`다.

실제 맥락·모델 근거는 [대화·자료 검증](25-context-and-evidence.md), 승인부터 복구까지 한 업무의 근거는 [대표 업무](29-representative-workflow.md)로 분리한다. 원격 CI 완료 여부는 해당 커밋에서 별도 확인한다. 다른 M1 Mac, 독립 디스크 복원, 개발자 외 신규 사용자 관찰은 이번 현재 Mac 검증과 구분한다.

### 동일 구현 커밋의 원격 CI

구현 커밋 `45636ce313e7a2afa16995ada09b964dcbf9b4d3`의 [GitHub Actions 실행](https://github.com/jonghyun0000/aios/actions/runs/34689809471)이 실제 Linux runner에서 **completed/success**, 2분58초로 종료됐다. head SHA와 각 단계 결과를 대조하고 로그의 실제 구조화 단언 수를 확인했다. 잠금 의존성 설치·타입·린트·빌드, 이식 가능 단위450/450, 읽기 전용 진단/검증기 경계51개, 독립 정적 데모24개, 실제 앱의 합성 API 접근성36/36이 통과했다. 접근성의 FAIL/SKIP/flaky/재시도는0이다. 현재 Mac의 실행 보고서와 원격 검사를 구분해 추적할 수 있으며, 이 확인 후 고정 평가표를90점으로 확정했다.
