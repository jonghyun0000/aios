# 공개 체험판과 배포 경계

작성: 2026-09-12. 실제 제품은 로컬 AI 작업공간이며 `apps/demo`는 소개를 위한 독립 정적 체험판이다.

## 체험 범위

- 정상 작업, 검증 실패, 수동 변경과 복구 충돌의 세 대화를 제공한다. 각 대화의 상태는 독립적이다.
- 가상 `sample/launch.md`의 전후 내용을 확인한 뒤 승인/거절하고, 현재 문자열과 기대 문자열을 실제로 비교한다. 검증 실패 시나리오는 일부러 잘못된 날짜를 반영한다.
- 승인 전에는 가상 파일도 바뀌지 않는다. 수동 수정 이후 복구는 충돌을 표시하고 해당 내용을 덮어쓰지 않는다. 오래된 승인·검증 결과는 무효 처리한다.
- Enter 전송, Shift+Enter 줄바꿈, 한글 조합 보호, 왼쪽 대화 목록, 모바일 펼침 메뉴를 제공한다.
- **모델 호출·명령 실행·실제 파일 수정·DB 저장은 없다.** 자유 입력은 최대 800자이고 예시 응답임을 표시한다. 데이터는 탭 메모리에만 유지되며 저장소·쿠키를 사용하지 않는다.

## 왜 로컬 제품을 그대로 올리지 않는가

실제 API에는 사용자 파일 접근·모델·DB·작업 워커가 있다. 이를 공개 데모 때문에 외부에 노출하지 않는다. 체험판은 같은 저장소의 별도 앱이고 API 프록시·환경 변수·사용자 데이터 없이 동작한다. GitHub에 공개된 소스가 있다고 실행 중인 로컬 서버까지 안전하게 공개할 수 있다는 뜻은 아니다.

`vercel.json`의 출력 대상은 `apps/demo/dist`다. CSP는 `connect-src 'none'`으로 네트워크 연결을 막고, 스크립트·스타일은 같은 출처의 파일만 허용한다. 프레임 삽입·폼 전송·카메라·마이크·위치 권한도 차단한다. 임의 경로를 모두 앱으로 바꾸는 rewrite는 없다.

## 직접 실행·검증

```bash
pnpm install --frozen-lockfile
pnpm run doctor --demo
pnpm demo
pnpm build:demo
node --test scripts/public-demo-policy.test.mjs
pnpm --filter @aios/web exec playwright install chromium
node scripts/verify-public-demo.mjs
```

`doctor --demo`는 Node·pnpm·저장소·설치·설정 등 체험판 준비물만 확인한다. Docker·Ollama·개인 설정을 실행하거나 변경하지 않는다. 일반 `pnpm run doctor`는 전체 로컬 제품 준비물을 별도로 진단한다.

브라우저 검증은 기본적으로 빌드 산출물을 임시 루프백 서버에서 제공하고 종료 후 서버를 닫는다. 공개 배포를 검사하려면 `AIOS_DEMO_URL`에 검증할 HTTPS 주소를 지정한다. 선택적으로 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`과 `AIOS_DEMO_ARTIFACTS`로 브라우저/결과 경로를 지정한다.

검사에는 정상 승인·거절·검증 실패·복구 충돌·대화 분리·초기화·IME·줄바꿈·안전한 텍스트 렌더링·모바일·키보드·404·보안 헤더·외부 요청/영속 저장 부재가 포함된다. `public-demo-policy.test.mjs`는 약한 CSP·다른 앱 출력·외부 redirect 결함을 거부하는지 시험한다.

## 배포와 현재 증거

Vercel에 `aios-demo` 프로젝트와 정적 배포를 생성했다. 업로드 범위는 감사한 HTML·JS·CSS·favicon 및 보안 헤더 설정뿐이다. 사용자 DB·모델·대화·키·실행 서버는 업로드하지 않았다.

공개 대표 주소: **[AIOS 체험판](https://aios-demo-mu.vercel.app)**. 최종 배포 ID는 `dpl_4h9y6C4ZWLvRQ42bQaKCP7yoE7mH`이다. Vercel의 긴 개별 배포 URL은 인증 보호가 걸릴 수 있지만 Domains에 등록된 Production 주소는 로그인 없는 접근을 확인했다. 미리보기 인증 보호는 끄지 않았고, 만료되는 인증 공유 URL을 README의 공개 체험 주소로 사용하지 않는다.

2026-09-12 실제 검증:

| 검사 | 결과와 범위 |
| --- | --- |
| 체험판 단위 | 34/34 PASS. 승인 상태, 잘못된 액션, 실패/복구와 입력 경계 |
| 배포 정책 결함 검사 | 3/3 PASS. 약한 CSP·실제 앱 출력·서버/프록시 경계 |
| 공개 Production 브라우저 | 24/24 PASS. 1366×900·390×844, 정상/거절/실패/충돌·입력·초기화·404·보안 헤더 |
| 공개 파일 동일성 | HTML·JS·CSS·favicon 4개 길이/SHA256가 최종 로컬 빌드와 일치 |
| 접근성 | 같은 빌드의 로컬 13개 화면 axe-core 4.10.3 자동 위반 0, 키보드/레이아웃 포함 40/40 확인 |
| 통신·저장 | 원격 브라우저 오류·실패 요청·API/외부 요청·쿠키·Storage 쓰기 0 |
| 공개 소스·안내 링크 | 구현 커밋 `d5966f9` 공개 후 저장소·데모 소스·안전 실행·평가·시작·체험 문서·기여/보안 안내 8개 HTTP 200 |

JS는 gzip 기준 54,355 bytes다. 다운로드 크기이며 사용자의 체감 속도 보장은 아니다. 공개 배포 갱신 전에는 새로운 자산이 404라서 동일성 검사가 실제 실패했고, 갱신 후 24개 검사 전체가 통과했다. 오래된 배포를 새 버전의 성공으로 오인하지 않는다.

접근성 검사는 낮은 작은 글자 대비, 잘못된 ARIA 속성, 승인 대기 중 키보드로 접근할 수 없던 채팅 스크롤을 찾아 수정했다. 일부 동적 화면의 자동 판정 보류는 스크롤 밖 요소·기호의 대비 판정 한계로 별도 검토했다. **전체 WCAG 준수 인증이나 보조기기/독립 신규 사용자의 실사용 시험은 아니다.** 공개 체험판의 통과를 실제 AIOS 전체 제품의 접근성 통과로 대체하지 않는다.

이번 배포는 연결된 배포 도구로 정적 산출물을 올린 수동 배포다. Git 저장소 자동 배포 연결은 설정하지 않았으며 `main` push만으로 사이트가 바뀌지 않는다. 이 문장은 2026-09-12 최초 배포 당시의 기록이다. 2026-10-01부터는 아래 "자동 배포"의 승인 게이트 워크플로를 쓴다(Vercel Git 연결은 여전히 쓰지 않는다). 다음 배포도 빌드·정책 검사 후 데모 출력만 배포하고, Production 주소에서 동일성/브라우저 검사를 다시 수행한다. 전체 로컬 서버나 개인 설정을 올리는 배포로 바꾸지 않는다.

GitHub CI에도 체험판 브라우저 검사를 포함한다. 실제 DB/Docker/LLM/T7 운영 시험이나 클라우드 자동 배포는 포함하지 않는다. 전체 제품 점수와 남은 검증은 [평가표](22-project-scorecard.md)를 따른다.

실제 원격 실행 기록: [`9a5d150` CI 성공](https://github.com/jonghyun0000/aios/actions/runs/34685116460). 이 실행은 Linux의 격리된 정적 데모 서버를 검사하며 위 Production 주소 검사는 별도로 수행했다.

## 자동 배포 (2026-10-01 추가)

`.github/workflows/deploy-demo.yml`이 체험판만 배포한다. 재배포는 여전히 사용자 승인 사항이며, 승인은 GitHub Environment `demo-production`의 Required reviewers가 맡는다.

흐름: (1) `main`에 체험판 관련 경로가 바뀌어 push되거나 Actions에서 수동 실행 → (2) `verify` 잡: 체험판 단위·배포 정책 시험·빌드·로컬 브라우저 회귀 → (3) `demo-production` 승인 대기 → (4) `deploy` 잡: `vercel pull` → `vercel build --prod`로 한 번 빌드 → `scripts/check-vercel-output.mjs`가 업로드 대상(`.vercel/output/static`)이 감사한 빌드와 같은 파일·SHA-256인지, 서버 함수가 없는지 확인 → `vercel deploy --prebuilt --prod` → (5) `verify-public-demo.mjs`가 `https://aios-demo-mu.vercel.app`의 헤더·404·바이트 일치·브라우저 회귀를 확인한다. 별칭 전환 지연에 대비해 원격 주소에서만 최대 120초(`AIOS_DEMO_RETRY_SECONDS`) 같은 검사를 반복하며 판정 기준은 바꾸지 않았다.

왜 이렇게 했는가:
- Vercel Git 자동 배포는 push 하나로 공개 사이트를 바꾸므로 승인 규칙과 충돌한다. 연결하지 않는다(이중 배포 방지).
- Vercel 서버에서 다시 빌드하면 검사한 바이트와 공개 바이트가 달라질 수 있다. CI에서 한 번 빌드한 결과를 그대로 올린다.
- 토큰은 Environment 비밀값에만 둔다. 승인된 `deploy` 잡만 읽고, PR·포크·`verify` 잡은 읽지 못한다.

`scripts/public-demo-policy.test.mjs`의 `validateDeployWorkflow` 시험은 승인 Environment 제거·이름 변경, 쓰기 권한, PR/`pull_request_target` 트리거, 경로 제한 없는 push, main 외 브랜치, 수동 실행 제거, `verify` 의존 제거, 검사 잡·전역 토큰 노출, CLI `latest`, 액션 태그 고정, 서버 재빌드 배포, 업로드 감사 생략·순서 역전, 배포 후 검증 생략, 진행 중 배포 취소의 18가지 결함을 각각 고유한 이유로 거부한다. 검사기에서 승인 게이트·토큰 격리·업로드 바이트 비교를 각각 무력화하면 시험이 실패하는 것도 확인했다(원복 후 `cmp` 일치).

### 사용자가 한 번 해야 하는 설정

1. Vercel 계정 설정 → Tokens에서 만료일이 있는 토큰을 만든다. 가능하면 `aios-demo`가 있는 팀으로 범위를 좁힌다.
2. `aios-demo` 프로젝트 Settings에서 Project ID와 Team(또는 계정) ID를 확인한다.
3. GitHub 저장소 Settings → Environments → `demo-production`을 만든다. Required reviewers에 본인을 넣고, Deployment branches를 `main`으로 제한한다.
4. 이 Environment의 비밀값으로 `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`를 등록한다(저장소 전체 비밀값이 아니라).
5. Vercel 프로젝트의 Git 연결은 끈 상태로 둔다.

설정 전에 워크플로가 실행되면 `deploy` 잡은 승인 없이 바로 시작되지만 토큰이 없어 `vercel pull`에서 실패한다. Required reviewers를 먼저 설정해야 한다.

되돌리기: 공개 주소 검증이 실패하면 Production에는 이미 새 배포가 반영된 상태다. Vercel 대시보드 Deployments에서 이전 배포를 Promote하거나 `vercel rollback`으로 되돌리고, 실패 실행 링크를 이 문서에 기록한다.

### 2026-10-01 구현 검증 (클라우드 세션)

| 검사 | 결과 |
| --- | --- |
| 정적 4단계(`verify-all`) | PASS. 단위 615/615 |
| CI의 node 시험 8파일 | 64/64 PASS |
| 배포 정책 시험 | 6/6 PASS. 워크플로 결함 18종 각각 의도한 이유로 거부, 업로드 대상 변조·추가·누락·서버 함수·라우트 누락 거부 |
| 검사기 역주입 | 승인 게이트·토큰 격리·바이트 비교 검사를 각각 끄면 시험 1건 실패 → 원복 `cmp` 일치 |
| actionlint 1.7.7 | `deploy-demo.yml`·`ci.yml` 오류 0 |
| 로컬 체험판 브라우저 회귀 | 24/24 PASS |
| 원격 재시도 | 공개 주소가 응답하지 않을 때 10초 간격 재시도 후 원래 오류로 실패, 범위 밖 값(9999초) 거부 |

**미검증:** 실제 Vercel 배포, GitHub Environment 승인 흐름, `vercel build`의 `.vercel/output/static`이 데모 빌드와 같은 파일 집합인지(Vercel이 다른 파일을 추가하면 `check-vercel-output.mjs`가 배포 전에 실패한다), 공개 주소 자체. 이 세션의 네트워크 정책이 `vercel.app`을 차단(프록시 403)해 현재 공개 배포 상태도 확인하지 못했다. 첫 실제 배포 결과는 사용자 설정 후 별도로 기록한다.
