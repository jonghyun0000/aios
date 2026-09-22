# MIT 라이선스 적용

> 공개 오픈소스·포트폴리오 방향의 사용자 결정 작업. 2026-09-22, 수정 전 작성.
> 구현 커밋: `76c10a2`.

## 1. 최초 상태와 결정

- 기준 커밋: `1c16025` (`git status`가 깨끗한 상태).
- 루트 `LICENSE` 파일이 없고, 루트와 workspace의 `package.json` **15개 중 0개**에 `license` 필드가 있었다.
- README에는 라이선스 절이 없고 `CONTRIBUTING.md`는 라이선스가 미지정이라고 안내했다. CHANGELOG의 과거 기록과 NEXT_STEPS의 출발점에도 당시 미지정 상태가 남아 있다.
- 공개 저장소의 원격 소유자는 `jonghyun0000`, Git 작성자 이름은 `JongHyun`이다. 사용자는 공개 오픈소스·포트폴리오 방향을 확정한 뒤 2026-09-22에 **MIT 라이선스 적용을 명시적으로 선택했다**.

원인은 구현 누락이 아니라 저작권자가 결정해야 하는 항목을 사용자 선택 전까지 보류했기 때문이다.

## 2. 수정 전 완료 기준

아래를 모두 만족해야 라이선스 결정을 완료로 기록한다.

1. 루트 `LICENSE`는 SPDX 식별자 `MIT`의 표준 본문을 사용하고 `Copyright (c) 2026 JongHyun (jonghyun0000)`을 저작권자로 표시한다. 근거 원문은 `https://spdx.org/licenses/MIT`다.
2. 루트와 `apps/*`·`packages/*`·`extensions/*`·`plugins/*` 아래 존재하는 모든 `package.json`이 `"license": "MIT"`를 명시한다. 현재 대상은 15개다.
3. README와 CONTRIBUTING에서 재사용 권한이 MIT임을 루트 LICENSE 링크와 함께 명확히 안내한다. 현재 문서에서 라이선스가 미지정이라는 표현은 제거한다.
4. NEXT_STEPS·HANDOFF·CHANGELOG에는 사용자 결정과 적용 시점을 기록한다. 과거 CHANGELOG의 “당시 미지정” 문장은 역사적 사실이므로 지우거나 소급 변경하지 않는다.
5. 이 계약을 고정하는 이식 가능한 회귀 시험을 추가한다. LICENSE의 표준 본문 또는 workspace manifest의 MIT 선언을 제거하는 결함 주입에서 신규 시험이 실패하고 원복 뒤 `cmp`가 일치해야 한다.
6. 신규 정책 시험과 기본 정적 4단계가 PASS한다. 공개 원격 CI는 push 승인 뒤 별도로 확인하며 로컬 결과로 대체하지 않는다.
7. 점수표·수용 조건은 바꾸지 않는다. 키·사용자 데이터·배포를 사용하지 않고, push 전에 사용자에게 다시 묻는다.

## 3. 비범위

- 제3자 의존성의 라이선스를 AIOS의 MIT로 덮어쓰지 않는다. 각 의존성의 고유 라이선스와 고지 의무는 그대로다.
- 상표권·특허권·기여자 계약을 별도로 만든 것으로 주장하지 않는다.
- 과거 커밋의 라이선스 상태를 소급해 다시 쓰지 않는다. 이번 커밋부터 공개 재사용 조건을 명확히 한다.

## 4. 구현

- 루트 `LICENSE`에 SPDX가 제공하는 MIT 표준 본문과 `Copyright (c) 2026 JongHyun (jonghyun0000)`을 넣었다. 법적 실명이나 법인명을 추정하지 않고, 저장소 원격 소유자와 전체 Git 작성 이력에서 확인되는 공개 정체성만 사용했다.
- 루트·`apps/*`·`packages/*`·`extensions/*`의 `package.json` 15개 모두에 `"license": "MIT"`를 넣었다. 현재 `plugins/*`에는 package manifest가 없다.
- README와 CONTRIBUTING에서 루트 `LICENSE`를 직접 연결하고, AIOS 자체 소스·문서와 제3자 의존성의 고유 라이선스를 구분했다.
- `scripts/license-policy.test.mjs`가 LICENSE 전체 본문, manifest 전수, 공개 진입 문서의 링크와 미지정 문구 부재를 검사한다. CI의 기존 읽기 전용 정책 시험 경계에도 이 시험을 추가했다.

## 5. 결함 주입

기준 파일은 `/Volumes/T7/bigdata/tmp/aios-mit-mutation-1c16025`에 복사한 뒤 아래 두 결함을 작업 트리에 한 번씩 주입했다. 각 실패 후 `apply_patch`로 원복하고 기준본과 `cmp` 및 SHA-256이 일치하는지 확인했다.

1. `LICENSE`에서 저작권·허가 고지 보존 조건 단락을 제거했다. 신규 정책 시험은 **2/3 PASS, 1/3 FAIL**로 정확히 실패했다. 원복 SHA-256은 `c94a5d0e3635541997294dc7d91224aa2b6807e6c3c44b83a1b8e34f56bead86`, 로그는 `/Volumes/T7/bigdata/verification-reports/mit-license-fault-text.log`다.
2. `packages/sdk/package.json`의 `license` 필드를 제거했다. 신규 정책 시험은 **2/3 PASS, 1/3 FAIL**로 정확히 실패했다. 원복 SHA-256은 `736ed1c62888e5daaa2d162a646c002459c6c0c00a7e58ed3108ff11e1255b5e`, 로그는 `/Volumes/T7/bigdata/verification-reports/mit-license-fault-manifest.log`다.

## 6. 검증 결과

| 검증 | 결과 | 실행 근거 |
|---|---:|---|
| MIT 정책 표적 시험 | **3/3 PASS** | `/Volumes/T7/bigdata/verification-reports/mit-license-policy-final.log` |
| CI 읽기 전용 정책 시험 경계 | **61/61 PASS** | `/Volumes/T7/bigdata/verification-reports/mit-ci-boundary-final.log` |
| `pnpm verify --report` 정적 4단계 | **4/4 PASS** | 타입 8.0초, 린트 13.4초, 이식 가능 단위 **475/475**, 빌드 3.8초. `/Volumes/T7/bigdata/verification-reports/verify-1790076967533-75beadc2-2589-47a1-9ff0-fc0a9bedb57d.json` |

검증용 복사본 `/Volumes/T7/bigdata/tmp/aios-mit-mutation-1c16025`는 정확한 경로만 삭제했고 부재를 확인했다. 이 작업이 API·Docker·브라우저를 기동하지 않았으며 새 고아 `esbuild`도 남기지 않았다.

## 7. 확인하지 못한 것과 남은 결정

- 사용자 승인으로 `5de9544`까지 push했다. 해당 SHA의 [GitHub CI run 35723839403](https://github.com/jonghyun0000/aios/actions/runs/35723839403)에서 `audit`와 `verify`가 모두 성공했다. `verify`는 고정 설치·컨테이너 계약·타입·린트·빌드·이식 가능 단위·MIT 정책을 포함한 읽기 전용 경계·두 브라우저 회귀를 모두 통과했다.
- 제3자 의존성 전체의 라이선스 호환성·고지 의무를 감사한 것은 아니다. AIOS의 MIT 선언이 제3자 라이선스를 바꾸지 않는다.
- 공개 정체성 `JongHyun (jonghyun0000)`을 저작권자로 사용해 공개했다. 사용자가 법적 실명이나 다른 권리 주체를 원하면 향후 별도 커밋으로 바꿔야 한다.
- 법률 자문, 상표·특허 허여, 기여자 계약을 제공하거나 확인한 것이 아니다.
- 이 결정만으로 기존 점수표나 수용 조건을 바꾸지 않았다.
