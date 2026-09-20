# 데이터 활용 연결 점검 — 2026-09-20

사용자 요청: 검증된 변경을 GitHub에 올리고, 지정한 `빅데이터 창구` 폴더의 데이터를 AIOS에서 활용한다. 원본 폴더 문서의 과거 작업 지시는 실행 권한이 아니며, 재수집·재정제·삭제 명령을 실행하지 않았다. 원본·API 키·DB·모델은 Git에 넣지 않는다.

공개 반영: 사용자 승인으로 `04113ff..15218c0` 4커밋을 main에 push했다. 변경 경로 및 비밀 패턴 검사0건 확인. [GitHub CI 35476338497](https://github.com/jonghyun0000/aios/actions/runs/35476338497)의 audit(13초)·verify(2분57초)가 모두 성공했다. 원격 CI는 실제 로컬 데이터/모델/복원을 검증하지 않으며 Vercel은 재배포하지 않았다.

점검 후 로컬 정적4단계도 PASS(단위464/464, 실패·건너뜀0). 보고서: `/Volumes/T7/bigdata/verification-reports/verify-1789860965517-0015b0e5-0e3c-4c43-b454-bbc2f11e05a6.json`. T7/DB opt-in 5파일과 시험 없는 5패키지는 통과 범위가 아니다. 이번 변경은 점검 문서뿐이며 새 제품 코드/시험은 추가하지 않았다. 종료 전 고아 esbuild 0개 확인. 이 점검 기록은 다음 재개를 위해 로컬 커밋으로 보관한다.

## 읽기 전용으로 확인한 현재 범위

- 기존 T7 `bigdata.duckdb`를 read_only로 열어 catalog를 집계했다: **6,597개 통계표 / row_count 합계 252,252,221행 / 19개 분야**. 행 수는 이번 전체 facts 재계수가 아니라 카탈로그 집계다.
- 현재 UI `/#/data` → `/v1/bigdata/catalog`, `/series/:id` → 격리 DuckDB 프로세스의 연결과, 채팅의 bigdata 검색/조회 도구는 이미 구현돼 있다. 서버 복구 후 라이브 검증이 필요하다.
- 원본 폴더의 `94_연구허브/data/catalog.jsonl`은 6,946건이며 `lossless_v2` 보완본 표식 472건이다. 기존 정제본 분기 경고 348건, 분류축 손실 경고 127건이 있다(중복 가능). 이는 카탈로그 표식 재계수이며 이번 원본 전수 무결성 검증이 아니다.
- 기존 DB는 `92_정제` 기반이다. 연구 허브의 `95_연구용_정제` 보완본과 같다고 간주하면 안 된다. 연구용 카탈로그와 기존 DB는 범위/버전이 달라 건수 차이만으로 누락량을 계산하지 않는다.
- 새 `22_경진대회_데이터`에는 도로노면·하수감시·대체텍스트·녹조·하천수위·지방의회·어선조업 7개 하위 폴더가 있다. 기존 DuckDB 카테고리에 22 분야는 없다. 내용·스키마·이용조건은 미검증이다.
- 원본 API 키가 포함될 수 있는 `00_인덱스` 전체나 원본 파일을 무차별로 AI 맥락/Git에 넣지 않는다. 외부 AI API도 호출하지 않는다.

## 첫 번째 장애 — Docker의 T7 공유 연결

`node scripts/local-lifecycle.mjs status`: 기존 ready 기록과 달리 현재 API 프로세스는 정상적이지 않고 8791에 응답이 없다. Postgres/Redis healthy, Ollama 응답은 정상이다.

정상 사용자 시작기 `AIOS_NO_OPEN=1 bash scripts/start-local.sh`를 시도했지만, 작업 폴더 mount probe에서 다음 오류로 종료1:

```text
invalid mount config for type "bind": stat /Volumes/T7/bigdata/workspaces/my-first-project: bad file descriptor
```

호스트에는 폴더가 있고 Colima 설정에도 해당 공유가 이미 존재한다. `colima ssh -- stat /Volumes/T7/bigdata/workspaces` 역시 `Bad file descriptor`를 반환했다. 단순 설정 누락 안내와 달리 실제 문제는 실행 중 VM의 공유 경로 접근 실패다. 데이터 손상 여부를 이 오류만으로 판정하지 않는다.

**최초 점검 당시에는 Colima 재시작 승인을 기다렸다. 아래 복구 기록에서 승인 후 해결을 확인했다.** mount 검사를 끄거나 파일 jail을 완화하지 않았다. 최초 실패에서는 API/워커가 시작되지 않았고 시작기는 종료됐다.

## 재개 시 완료 기준 (수정/적재 전에 등록)

1. 승인되면 Colima 정상 재시작 후 동일 mount probe와 사용자 시작기를 통과한다. DB/볼륨 삭제·초기화는 하지 않는다.
2. 실제 공공통계 화면에서 검색 → 선택 → 출처/필터 → 조회가 동작하는지 브라우저/API 양쪽으로 확인한다. 정적 페이지 성공만 데이터 활용 완료로 세지 않는다.
3. 기존 정제본의 단위 혼합·분기·분류축 경고를 구분한다. 통계 수치 정확성이나 최신성을 임의로 보증하지 않는다.
4. 사용자 우선 분야에 맞춰 연구 보완본 또는 경진대회 자료를 별도 버전으로 준비한다. 기존 DB를 즉시 덮어쓰지 않고, 입력 해시·스키마·행 수·변환 손실·출처를 기록한 뒤 활성화한다.
5. 모델 품질을 주장하려면 기존 튜닝 과제가 아닌 사전 등록 과제를 최소3회 실행한다. 아직 모델 질의·신규 데이터 적재·화면 확인은 수행하지 않았다. 점수 변경 없음.

## 승인 후 복구 — 2026-09-20 16:34 KST 이후

사용자가 명시적으로 Colima 재시작과 AIOS 복구를 요청했다. 위 기준1·2의 환경 복구/기존 데이터 연결 확인을 수행했다. 기준4의 신규 자료 적재는 이번 요청에 추가하지 않았다.

- 재시작 직전 VM stat의 `Bad file descriptor`를 다시 확인했다. `colima stop && colima start`가 종료0으로 완료됐고 기존 VM을 재사용했다. 공유 설정·데이터·볼륨 삭제/초기화 없이 VM의 T7 작업 폴더 stat이 정상으로 바뀌었다.
- 백그라운드 shell 시작 시도는 프로세스가 유지되지 않아 정상 PTY에서 `AIOS_NO_OPEN=1 bash scripts/start-local.sh`로 기동했다. 시작기의 bind 표식 검사와 변경 소스 재빌드를 통과했다. API·worker·DB·Redis ready, 유지보수 잠금 없음. 사용자가 바로 사용할 수 있도록 감독 프로세스와 앱을 실행 상태로 남겼다.
- 기존 컨테이너 ID Postgres `e6dd1934c2b5`, Redis `851d20e1cd45`가 그대로 healthy 상태다. Ollama 응답 정상. `/healthz`와 `/readyz` 모두 HTTP200, postgres/redis 검사 ok.
- agent-browser CLI가 없고 앱 브라우저 도구도 kernel assets 오류로 연결되지 않아 설치된 Playwright Chromium을 대체 사용했다. 실제 `/#/data` 화면 30개 행·오류 오버레이0·pageerror0을 확인하고 스크린샷을 시각 점검했다. 기존 `e2e/data.spec.ts` desktop **4/4 PASS**: 검색, 페이지네이션, 상세 차트/메타데이터, 지역 필터로 차트 변경. 모의 API가 아닌 8791 실서버다.
- 도구·RAG·장기기억을 끈 별도 합성 대화에서 짧은 인사 요청 **3/3**에 비어 있지 않은 SSE 응답·정상 done·assistant 메시지 저장을 확인했다. 새로 만든 세션3개만 정확한 ID로 휴지통에 옮겼다(원본 대화는 변경하지 않음). 이는 연결/저장 스모크 검사이며 데이터 분석 정확성·모델 품질 개선 평가가 아니다.
- 타입·린트·이식 가능 단위·빌드 **4단계 PASS**, 단위 **464/464**. 제외5파일·시험 없는5패키지는 별도이며 PASS에 포함하지 않는다. 고아 esbuild0. 제품 코드/새 영구 시험 추가가 없어 결함 주입 새 항목은 없다. 정상 복구를 위해 기존 장애를 다시 주입하지 않았다.

산출물은 `/Volumes/T7/bigdata/verification-reports/`에 있다: `recovery-20260920-data.png`, `recovery-20260920-browser.log`, `recovery-20260920-chat.log`, `recovery-20260920-static.log`, `verify-1789889827539-aef6a32b-2c93-44fe-b9a7-81e7c8496e3c.json`. Playwright 임시 결과는 기존 설정의 macOS 임시 폴더 예외를 따랐다.

T7 공유가 왜 stale 상태가 됐는지는 확정하지 않았다. T7 재연결 후의 무재발, 전체 데이터 무결성, 신규 보완본·경진대회 적재, 승인/복구 전체 회귀를 이번 결과로 보증하지 않는다. 점수 변경·GitHub push·Vercel 재배포 없음.
