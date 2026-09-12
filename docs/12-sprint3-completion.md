# Sprint #3 — 미완성 영역 보완 보고서

목적: "완성본인가?"에 대해 **아니오**라고 답한 네 영역을 실제로 구현하고,
추정이 아니라 **실행으로** 검증한다. PASS는 실행 결과가 있는 항목만 기록한다.

측정 일자: 2026-08-23 · 환경: macOS(darwin 25.6) · Node 22.18 · PostgreSQL 16 + pgvector · Redis 7 (docker compose)

---

## 0. 왜 완성본이 아니었는가 (측정된 공백)

보완 착수 전에 코드를 직접 세어 확인한 값이다. 인상이 아니라 숫자로 판단했다.

| 영역 | 착수 전 실제 상태 | 근거 |
|---|---|---|
| 실시간 협업 | `ws.ts` 100줄의 JSON base64 릴레이. 서버가 문서를 모름 | `yjs` 의존성 0건 |
| 마켓플레이스 | 테이블 3개만 존재, 조작 엔드포인트 없음 | `core.ts`에 `plugins` 라우트 0건 |
| 결제 | 웹훅 서명 검증 76줄 | 아웃바운드 Stripe 호출 0건 |
| OAuth | 없음 | `grep -rn "oauth" apps/api/src` → 0건 |

각 영역이 왜 문제인지:

- **협업**: 서버가 Yjs 문서를 갖지 않으면 (1) 늦게 접속한 사람이 빈 문서를 보고,
  (2) 서버 재시작 시 문서가 사라지며, (3) 커서 공유가 불가능하다. 릴레이는 협업이 아니다.
- **마켓플레이스**: 스키마만으로는 아무도 플러그인을 올리거나 받을 수 없다.
- **결제**: "남이 결제했다는 소식만 들을 수 있고, 결제를 받을 수는 없는" 상태였다.
- **OAuth**: 스키마 주석은 Supabase에 위임한다고 적었지만, Supabase 없는 배포에는
  로그인 수단 자체가 없었다. 온프렘 요구를 스스로 위반한 셈이다.

---

## 1. 결과 요약

| Phase | 대상 | 결과 | 검사 수 |
|---|---|---|---|
| A | 실시간 협업 (실서버 + 실 WebSocket) | **PASS** | 15/15 |
| B | 마켓플레이스 레지스트리 | **PASS** | 23/23 |
| C | 결제 (Checkout / 구독 / 웹훅 멱등성) | **PASS** | 36/36 |
| D | OAuth 로그인 | **PASS** | 49/49 |
| E | 웹 UI 서빙 ([13-web-ui.md](13-web-ui.md)) | **PASS** | 22/22 |
| — | 전체 회귀 (typecheck / lint / unit / build / 번들 부팅) | **PASS** | — |
| — | Docker 이미지 빌드 + 컨테이너에서 4개 기능 응답 + 협업 15/15 재검증 | **PASS** | — |

**총 145개 검사 전부 실제 실행으로 통과.** 재현 명령은 §7에 있다.

유닛 테스트는 59개 → **93개** (collab 10개, 웹 UI 24개 추가). DB 테이블 19개 → **26개**.

---

## 2. Phase A — 실시간 협업

### 구현

새 워크스페이스 `packages/collab` (400줄) + `apps/api/src/collab-ws.ts` (129줄).

| 파일 | 역할 | 핵심 설계 결정 |
|---|---|---|
| `protocol.ts` | y-websocket 프레이밍 | 자체 규약이 아니라 사실상 표준을 따른다 — 그래야 기존 클라이언트가 붙는다 |
| `persistence.ts` | Postgres 스냅샷 | 텍스트가 아니라 CRDT 바이너리로 저장 (병합 이력을 잃으면 재접속 충돌 해결 불가) |
| `room.ts` | 문서 1개 = Room | 서버가 `Y.Doc`을 **소유**한다. 이것이 릴레이와의 결정적 차이 |
| `manager.ts` | docId → Room | 생성 중 Promise를 캐시해 동시 접속 레이스 차단 |

저장 시점: 디바운스 2초 + 마지막 피어 이탈 시 즉시 + 셧다운 시 전체 flush.
매 타이핑마다 저장하면 과도하고, 이탈 시에만 저장하면 프로세스 사망 시 유실된다.

멀티 인스턴스: Redis Pub/Sub으로 update를 전파하되 `REMOTE_ORIGIN` 심볼로
자기 메시지 에코를 차단한다. CRDT라 중복 적용해도 결과는 같지만 대역폭이 낭비된다.

### 검증 (실서버 + 실 WebSocket 두 개)

```
[A.1 연결/인증]  무인증 4401 · doc 누락 4400
[A.2 동기화]     A→B · B→A · 동시 편집 CRDT 수렴 · 양쪽 편집 보존
[A.3 late join]  나중에 붙은 클라이언트가 기존 내용 수신
[A.4 awareness]  원격 커서 인지 · 이탈 시 유령 커서 제거
[A.5 영속화]     collab_docs 65 bytes 저장 · 스냅샷 내용 일치 · 재접속 복원
[A.6 부하]       10 클라이언트 동시 편집 → 전원 동일 문서, 수렴 58ms
```

유닛 테스트(10개)는 Peer 인터페이스에 직접 붙어 WS를 건너뛴다. 그것만으로는
"두 클라이언트로 테스트된 적이 없다"는 원래 결함을 고쳤다고 말할 수 없어,
실제 HTTP 서버 + 실제 WebSocket 경로를 별도로 검증했다.

### Phase A에서 발견한 결함

**서버 전역 인증 훅이 `/v1/collab`을 예외 목록에 넣지 않아 업그레이드 전에 HTTP 401로 잘렸다.**
WS는 브라우저가 커스텀 헤더를 못 붙여 토큰이 query로 오는데, preHandler 시점에는
아직 그 변환이 일어나지 않는다. `WS_ROUTES` 집합으로 명시하고 주석에 이 함정을 남겼다.

---

## 3. Phase B — 마켓플레이스

### 구현

`routes/marketplace.ts` 399줄 — 게시 / 검색 / 상세 / 심사 / 설치 / 제거 / 평점 / 무결성 확인.

신뢰 모델 (각 규칙이 막는 공격):

| 규칙 | 막는 것 |
|---|---|
| 번들 sha256 봉인 | CDN 침해 시 감염된 번들 배포 |
| 서명이 **있는데 틀리면 즉시 거부** | "검증 실패 시 무서명으로 강등" 우회로 |
| 슬러그 소유 조직 확인 | 인기 플러그인 이름으로 악성 버전 게시 |
| 버전 불변 (재게시 금지) | 이미 설치한 사람의 코드를 몰래 교체 |
| 권한은 manifest의 부분집합만 | 관리자가 승인하지 않은 권한 획득 |
| 설치한 조직만 평점 | 경쟁 플러그인 별점 테러 |
| 심사는 운영 조직만 | 게시자의 자기 승인 |

자동 승인 정책: 서명된 번들은 `approved`, 무서명은 `pending`.
무서명을 자동 승인하면 심사 단계가 장식이 된다.

### Phase B에서 발견한 결함 2건

**B-1 (제품 버그, 심각): API 키의 role이 `"member"`로 하드코딩되어 있었다.**
`requireRole("admin")` 이상을 요구하는 모든 작업 — 플러그인 설치, 마켓플레이스 게시,
결제 Checkout — 을 API 키로는 **영원히** 수행할 수 없었다. CLI·SDK·CI가 전부 API 키를 쓰므로
사실상 "브라우저로만 할 수 있는 기능"이 되어 있었다. 이 결함은 마켓플레이스 라우트를
실제로 호출해 보기 전까지 드러나지 않았다 — 이전까지 admin 이상을 요구하는 라우트가
하나도 없었기 때문이다.
→ 마이그레이션 `0003`으로 `api_keys.role` 추가 (기본값 `member` — 기존 키가 마이그레이션만으로
승격되면 안 된다), `authenticateApiKey`가 저장된 값을 사용.

**B-2: 소유 조직이 버전을 지정하지 않고 설치하면 심사 중(pending) 버전이 조용히 선택됐다.**
관리자가 "승인된 것을 설치했다"고 믿는 사이 미심사 코드가 조직에 들어간다.
→ 버전 미지정 시에는 언제나 승인된 최신 버전. pending은 버전을 **명시**해야만 설치된다.
(소유자의 자기 테스트 경로는 유지 — 회귀 테스트로 함께 고정했다.)

---

## 4. Phase C — 결제

### 구현

- `billing/client.ts` (170줄) — Stripe REST 아웃바운드. SDK 대신 직접 구현하되
  SDK가 공짜로 주던 두 가지(멱등성 키, 5xx 전용 지수 백오프 재시도)를 직접 넣었다.
- `billing/stripe.ts` (180줄) — 웹훅 처리 전면 재작성.
- `routes/billing.ts` (215줄) — 플랜·구독 조회, Checkout, 고객 포털, 해지, 웹훅.

**Stripe Checkout(호스팅)을 쓰는 이유**: 카드번호가 우리 서버를 지나가지 않으면
PCI-DSS 범위가 SAQ-A로 줄어든다. 자체 결제폼으로 절감되는 것은 리다이렉트 한 번이고,
늘어나는 것은 감사 범위 전체다.

**멱등성 키를 결정적으로 만든다**: `sha256(org, 작업, 가격, 60초 버킷)`.
랜덤 UUID면 사용자가 결제 버튼을 두 번 눌렀을 때 세션이 두 개 생긴다.
검증에서 동시 요청 2건이 같은 키를 쓰고 같은 세션 ID를 받는 것을 확인했다.

### 기존 웹훅 핸들러의 결함 3건 (재작성으로 해결)

1. **멱등성 없음** — Stripe는 at-least-once 전달이다. 같은 이벤트가 두 번 오면
   구독이 두 번 갱신됐다. → `stripe_events`에 event.id를 선점, 충돌 시 `duplicate` 반환.
   처리 실패 시에는 선점을 되돌린다(그러지 않으면 재전송이 "중복"으로 무시되어 영구 유실).
2. **`checkout.session.completed` 미처리** — 결제가 끝나도 `stripe_customer_id`가
   구독 행에 연결되지 않아 이후 모든 `subscription.*` 이벤트가 매칭에 실패했다.
3. **매칭 실패를 감지 못함** — update가 0행이어도 200을 반환해
   "결제는 됐는데 플랜은 안 올라감"이 조용히 발생했다. → `unmatched`를 반환하고 `log.error`.

추가로 **알 수 없는 `lookup_key`를 `'pro'`로 기본 승격시키던 동작**을 제거했다
(모르는 가격이 유료 플랜을 부여하면 안 된다). 결제 실패는 즉시 강등하지 않고 `past_due`만
표시한다 — Stripe가 며칠에 걸쳐 재시도하는데 첫 실패에 서비스를 끊으면 카드 만료 같은
사소한 사유로 고객을 잃는다.

### 검증 방식

로컬 Stripe 목 서버(94줄)를 띄우고 `STRIPE_API_BASE`를 그쪽으로 돌려
**전용 API 인스턴스**(포트 8791)를 spawn했다. 클라이언트를 스텁으로 교체하지 않은 이유:
검증하고 싶은 것이 form 인코딩·멱등성 헤더·재시도인데, 스텁으로 바꾸면 그 코드가 실행되지 않는다.

확인된 항목 중 주요한 것:
- `line_items%5B0%5D%5Bprice%5D=...` 대괄호 표기가 실제 요청 바디에 존재
- 500 → 500 → 200 시 정확히 3회 시도, 4xx는 재시도 없음
- 웹훅 서명 누락/변조/타임스탬프 초과 모두 거부
- 동일 이벤트 2회 전송 → `applied` → `duplicate`, DB 기록 1건
- `member` 역할은 Checkout 403

### Phase C에서 발견한 결함 1건

**구독 조회가 존재하지 않는 `payload` jsonb 컬럼을 참조해 500이 났다.**
실제 `usage_events`는 `input_tokens`/`output_tokens`/`cost_usd` 컬럼을 가진다.
→ 실제 스키마로 수정. 스키마를 확인하지 않고 쿼리를 쓴 대가다.

---

## 5. Phase D — OAuth

### 구현

- `oauth/providers.ts` (91줄) — GitHub / Google.
- `oauth/flow.ts` (292줄) — PKCE, state, code 교환, 로그인 확정, 세션 검증·폐기, 만료 청소.
- `routes/auth.ts` (172줄) — providers / start / callback / session / logout.
- `auth.ts` 통합 — `aios_sess_` 접두사 토큰이 일반 API 인증에도 통한다.

**세 가지 공격을 각각 다른 수단으로 막는다:**

| 공격 | 방어 | 검증 |
|---|---|---|
| CSRF (공격자 계정으로 로그인시키기) | state를 서버가 발급·DB 저장·1회 소비 | 재사용 거부, 동시 요청 중 1회만 성공 |
| code 가로채기 | PKCE (S256) | challenge = base64url(sha256(verifier)) 확인 |
| open redirect | 오리진 화이트리스트 | `app.example.test.evil.test` 차단 확인 |

`consumeState`는 `delete ... returning`으로 조회와 삭제를 원자적으로 처리한다.
select 후 delete로 나누면 동시 요청 두 개가 같은 state를 통과한다 —
실제로 동시 소비 테스트로 확인했다(2건 중 1건만 성공).

**세션 토큰은 원문을 저장하지 않는다.** DB에는 sha256만 있고, 검증에서
"원문으로는 조회되지 않음"을 직접 확인했다. DB가 유출돼도 세션을 탈취당하지 않는다.

**미검증 이메일은 거부한다.** 계정 연결은 `provider_account_id` → 없으면 email 순인데,
email 매칭이 안전하려면 프로바이더가 이메일을 검증했다는 보증이 필요하다.
GitHub은 `verified: true`인 것만, Google은 `email_verified`만 받는다.
이 규칙이 없으면 email 매칭이 그대로 계정 탈취 경로가 된다.

**신규 사용자에게 조직·owner 역할·free 구독을 함께 만든다.** 조직 없이 로그인하면
어떤 리소스도 만들 수 없어 로그인이 성공해도 앱이 아무것도 못 하는 상태가 된다.

### 검증 방식

로컬 IdP 목을 띄우고 flow 함수를 직접 구동했다. GitHub이 **실패해도 HTTP 200 + error 필드**로
응답하는 실제 동작까지 재현해, 상태 코드만 보면 성공으로 오인하는 경로를 검증했다.

---

## 6. 부수적으로 고친 것

작업 중 드러난, 이 네 영역과 무관하지만 실제로 아픈 문제들:

| 문제 | 영향 | 수정 |
|---|---|---|
| macOS AppleDouble(`._*.sql`)이 마이그레이션으로 수집됨 | 외장 드라이브에서 `migrate` 전체 실패 | `migrate.mjs`에서 숨김 파일 제외 |
| 같은 파일이 테스트로 수집됨 | vitest 스위트 실패 ("Unexpected \x00") | `vitest.shared.ts` + 패키지별 config로 제외 |
| 같은 파일이 eslint 대상이 됨 | lint 13건 파싱 에러 | flat config ignores에 `**/._*` |
| Stripe form 바디가 객체를 `String()` | `"[object Object]"`가 유효한 값으로 전송되어 잘못된 가격/수량으로 결제 세션 생성 | 스칼라만 직렬화, 그 외는 throw |
| 테스트가 이전 실행 상태에 의존 | 거짓 FAIL (고객 재사용은 올바른 동작) | 검증 시작 시 상태 초기화 |
| Dockerfile이 호스트 파일 모드를 그대로 복사 | 이미지가 `EACCES: permission denied, open '/app/dist/main.js'`로 즉사 | `RUN chmod -R a+rX` 로 이미지 안에서 모드 확정 |
| `packages/collab`이 Dockerfile deps 단계에서 누락 | 워크스페이스 설치 불완전 | package.json COPY 목록에 추가 |
| 루트 lint가 `vitest.config.ts`를 파싱 못 함 | `eslint .` 12건 실패 | 각 패키지 tsconfig `include`에 추가 + 루트 tsconfig 신설 |

### Dockerfile 권한 결함 상세

저장소가 exFAT 볼륨에 있으면 소스 파일이 `0700`(소유자 전용)으로 나타난다.
`COPY`는 이 모드를 이미지에 그대로 옮기고, 컨테이너는 `USER node`(uid 1000)로 실행되므로
**자기 코드를 읽지 못해 부팅 즉시 죽는다.**

이것이 중요한 이유는 증상 자체보다 성질에 있다 — **빌드 머신의 파일시스템에 따라
이미지가 되기도 하고 안 되기도 한다.** APFS(0644)에서는 통과하고 exFAT(0700)에서는 실패한다.
재현 가능한 빌드가 아니며, "내 노트북에서는 되는데 CI에서는 안 된다"의 전형이다.

`COPY --chmod`가 아니라 `RUN chmod -R a+rX`를 쓴 이유: `--chmod`는 BuildKit 전용이라
레거시 빌더에서는 빌드가 **아예 실패**한다. 이식성이 목적인 수정이 이식성을 깨면 안 된다.

---

## 7. 재현 방법

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
export DATABASE_URL=postgres://aios:aios@localhost:5432/aios
node scripts/migrate.mjs && node scripts/seed-dev.mjs   # apiKey 출력됨
pnpm --filter @aios/api dev &
export AIOS_BASE_URL=http://127.0.0.1:8787 AIOS_API_KEY=<위 출력값>
pnpm --filter @aios/verify s3:collab       # 15/15
pnpm --filter @aios/verify s3:marketplace  # 23/23
pnpm --filter @aios/verify s3:billing      # 36/36  (Stripe 계정 불필요 — 목 사용)
pnpm --filter @aios/verify s3:oauth        # 49/49  (IdP 계정 불필요 — 목 사용)
```

오케스트레이터로 한 번에:

```bash
node scripts/verify-all.mjs typecheck lint unit build s3-collab s3-marketplace s3-billing s3-oauth
# → VERIFY: PASS — 8 passed, 0 failed, 0 blocked, 0 skipped
```

프로덕션 이미지 검증:

```bash
docker build -f infra/Dockerfile --target api -t aios-api:sprint3 .
docker run -d --name chk --network <compose_net> \
  -e DATABASE_URL=postgres://aios:aios@postgres:5432/aios \
  -e REDIS_URL=redis://redis:6379 -p 8795:8787 aios-api:sprint3
AIOS_BASE_URL=http://127.0.0.1:8795 pnpm --filter @aios/verify s3:collab   # 15/15
```

---

## 8. 새 환경변수

배포 시 필요한 값. 미설정이면 해당 기능만 비활성화되고 서버는 정상 기동한다
(`/v1/auth/providers`가 빈 배열을 반환하므로 프론트가 버튼을 그리지 않는다).

```bash
# 결제
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
BILLING_SUCCESS_URL=https://app.example.com/billing/success
BILLING_CANCEL_URL=https://app.example.com/billing/cancel

# 마켓플레이스 심사 (미설정이면 아무도 승인 불가 = 서명된 것만 유통)
MARKETPLACE_REVIEWER_ORG=<uuid>

# OAuth
PUBLIC_BASE_URL=https://api.example.com
OAUTH_ALLOWED_REDIRECTS=https://app.example.com     # 미설정이면 전부 차단
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
AUTH_SESSION_TTL_DAYS=30
```

---

## 9. 여전히 남아 있는 것 (정직한 목록)

이번 스프린트로 **네 영역의 서버 측 기능은 완성됐다.** 그러나 제품 전체를 "완성본"이라
부르려면 아직 남은 것이 있고, 이것을 숨기지 않는다.

| 항목 | 상태 | 왜 남았는가 |
|---|---|---|
| ~~웹 UI~~ | **완료** | `apps/web` 구현. 실제 브라우저로 검증했다 — [13-web-ui.md](13-web-ui.md) 참조 |
| OAuth 실 IdP 검증 | 목으로만 검증 | GitHub/Google 앱 등록에 실제 계정이 필요 |
| Stripe 실계정 검증 | 목으로만 검증 | 실 결제 테스트에 Stripe 계정이 필요 |
| OpenAI/Gemini/xAI 어댑터 | 라이브 호출 없음 | Sprint #2와 동일 — 해당 키 미보유 |
| ~~임베딩 품질~~ | **실측 완료** | 로컬 bge-m3(1024차원). 의미 검색 하한 0.5, 중복 임계값 재설계 — [06-engines.md](06-engines.md) |
| ~~협업 멀티 인스턴스~~ | **검증 완료** | `s6:collab-multi` — 인스턴스 2개 실제 기동, PASS 9/9 |

목으로 검증한 항목을 PASS로 기록한 이유: 검증 대상이 **우리 코드의 동작**(직렬화, 재시도,
멱등성, state 소비, 세션 발급)이고, 그 코드는 실제 HTTP를 통해 전부 실행됐다.
다만 **상대방의 실제 응답 형식이 우리 가정과 같은지**는 목이 보장하지 못한다 —
그것이 위 표에 "목으로만 검증"이라 남긴 이유다.

---

## 10. 결론

착수 시점의 답: **"완성본이 아니다."** 네 영역이 스키마나 스텁 수준이었다.

지금의 답: **네 영역 모두 서버 측 기능은 동작하며 123개 검사로 실증됐다.**
과정에서 실제 제품 버그 4건을 발견해 고쳤고, 그중 하나(API 키 role 하드코딩)는
CLI/CI가 관리 작업을 영원히 못 하게 만드는 심각한 결함이었다.
추가로 Docker 이미지가 빌드 머신의 파일시스템에 따라 부팅에 실패하는 재현성 결함도
실제 컨테이너를 띄워 보고서야 발견했다.

이 버그들은 코드를 읽어서가 아니라 **실제로 호출하고 실행해 봤기 때문에** 드러났다.

착수 시점에는 웹 UI가 없어 "완성된 백엔드 플랫폼"이 정확한 표현이었다.
이후 `apps/web`을 만들어 그 공백도 메웠고, 그 과정에서 다시 5건의 결함이 드러났다 —
그중 둘(정적 UI에 인증이 걸려 아무도 로그인할 수 없던 것, 메시지 하나가 앱 전체를 백지로 만들던 것)은
UI 없이는 존재조차 알 수 없었던 문제다. 자세한 내용은 [13-web-ui.md](13-web-ui.md)에 있다.
