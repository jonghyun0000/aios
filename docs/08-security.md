# 15. 보안

**초기 보안 설계/로드맵 문서다.** 아래의 KMS·암호화·TLS 강제·zero-retention 계약·법적 삭제 요건·SOC2 계획은 현재 Mac/T7 배포에서 적용/인증됐다는 근거가 아니다. 프로젝트는 해당 보안 인증이나 법규 준수를 주장하지 않는다. 현재 로컬 제품의 실제 경계와 미검증 사항은 [SECURITY.md](../SECURITY.md), [안전 실행](19-stage3-execution-safety.md), [운영과 복원](20-stage4-local-operations.md), [최신 평가·결함 검증](22-project-scorecard.md)을 따른다.

2026-09-12에는 viewer의 대화/자료/협업 쓰기를 차단하고, API와 워커의 색인 경로·조직 경계 및 비밀 없는 요청/오류 로그를 보완했다. 공개 웹 체험판은 실제 로컬 API·파일·DB에 연결하지 않는다. 이것이 전면 보안 감사나 호스트 관리자/전원 장애까지 포함한 안전 보증은 아니다.

## 15.1 위협 모델 (LLM 에이전트 특유의 위협 포함)

| 위협 | 방어 |
|---|---|
| **프롬프트 인젝션** (코드/문서/MCP 결과에 숨은 지시) | ① 도구 결과·RAG 청크는 "데이터" 프레임으로 감싸 시스템 지침과 구분 ② 위험 도구(exec/write/net)는 정책상 confirm 기본 ③ 샌드박스가 최종 방어선 — 인젝션이 성공해도 network=none 컨테이너 안 |
| 데이터 유출 (플러그인/도구 경유) | 플러그인 net 권한은 호스트 화이트리스트, 아웃바운드는 호스트 대행. 경로 jail(fs 도구는 프로젝트 루트 밖 접근 불가) |
| 공급망 (마켓플레이스 악성 번들) | sha256 + 개발자 ed25519 서명, 정적 분석 게이트, 권한 최소화 승인 UI |
| 테넌트 간 격리 실패 | 모든 쿼리에 org_id 필수(리포지토리 레이어에서 강제), Supabase 직결 경로는 RLS, 샌드박스는 테넌트별 컨테이너 |
| 크리덴셜 유출 | API 키 해시 저장, 프로바이더 키는 KMS/secret manager, 로그에 본문 마스킹 |
| 과금 남용 | 조직별 rate limit + 월 토큰 쿼터(Redis 카운터, hot path에서 차단), 이상 사용 알림 |

## 15.2 인증/인가

- **인증**: Supabase Auth (OAuth: GitHub/Google) → JWT(HS256, `SUPABASE_JWT_SECRET` 검증). 기계는 API 키(`aios_live_*`, sha256 조회, scope 제한).
- **인가**: org_members.role 기반 RBAC — viewer(읽기) < member(세션/도구) < admin(프로젝트/플러그인/빌링) < owner(멤버/삭제). 미들웨어 `requireRole`이 라우트 단위 강제.
- 감사: 권한 변경·플러그인 설치·도구 exec는 audit_logs에 무조건 기록 (append-only).

## 15.3 데이터 보호

- 전송: TLS 1.3 강제. 저장: Supabase 디스크 암호화 + 민감 컬럼(외부 토큰 등)은 앱 레벨 AES-GCM.
- 삭제권(GDPR): memory_items/messages는 hard delete + 임베딩 동반 삭제. usage_events는 익명화(법적 보존).
- LLM 프로바이더에는 zero-retention 계약 옵션 적용, org 단위로 "허용 프로바이더" 정책 설정 가능(예: 규제 고객은 특정 프로바이더 제외).

## 15.4 컴플라이언스 로드맵
SOC2 Type I(6개월) → Type II(18개월). 필요한 증적(감사 로그, 접근 통제, 변경 관리=CI 게이트)은 아키텍처에 이미 내장 — 나중에 붙이는 것보다 10배 싸다.

## 15.5 의존성 공급망 — 프로덕션 의존성 취약점 (2026-09-19)

**발견.** `pnpm audit --prod` 가 **15건**(high 11, moderate 3, low 1)을 보고했다. 앞 절들의 인가·경계 시험은 애플리케이션 로직만 다뤘고 프레임워크 계층은 점검 대상이 아니었다.

| 패키지 | 고정돼 있던 버전 | 권고 요지(요약) | 수정 버전 |
|---|---|---|---|
| fastify | 4.29.1 | Content-Type 의 탭 문자로 본문 검증 우회, `request.protocol/host` 스푸핑, 스키마 검증 우회, `sendWebStream` 메모리 DoS | ≥5.12.1 |
| @fastify/static | 7.0.4 | 경로 우회에 의한 route guard 우회, 비정규 URL 로 인가 우회 | ≥10.1.2 |
| find-my-way | 8.2.2 | HTTP/2 DDoS | ≥9.7.0 |
| fast-uri | 3.1.5 (락파일 고정) | 호스트 혼동, SSRF 유형 | ≥3.1.6 |

**노출도 — 과장하지 않는다.** 위 등급은 권고 데이터베이스의 심각도이지 이 제품에서 실제로 악용된다는 증명이 아니다. 악용 가능성은 **검증하지 않았다.** 다만 완화 요인은 실제로 확인했다: `LOCAL_NO_AUTH` 는 `127.0.0.1` 로 바인딩을 강제하고 `req.ip` 가 아닌 소켓 주소로 루프백을 판정한다(`apps/api/src/main.ts`, `auth.ts`). 반대로 `HOST` 기본값은 `0.0.0.0` 이라, 키 인증 모드(`dev-up.sh`)의 서버는 LAN 주소에서도 리슨한다.

**조치.** `fastify ^5.12.5`, `@fastify/cookie ^11.1.2`, `@fastify/cors ^11.3.0`, `@fastify/static ^10.1.4`, `@fastify/websocket ^11.3.1`(`apps/api`), `fastify ^5.12.5`(`apps/verify`). fast-uri 는 락파일을 semver 범위 안에서 재해석해 3.1.8 로 올렸다 — 영구 `overrides` 를 남기지 않았다. 결과: `pnpm audit --prod` **15 → 0건.**

**타입 검사도 단위 시험도 잡지 못하는 동작 변경 — 업그레이드에서 실제로 발견한 것.**

1. **`@fastify/cors` 기본 `methods` 가 v10 부터 `GET,HEAD,POST` 로 좁아졌다**(v9 는 `PUT,PATCH,DELETE` 포함). 이 앱은 `origin: true` 라 다른 오리진(개발용 Vite 등)에서 PUT/PATCH/DELETE 프리플라이트가 **조용히** 실패한다. `apps/api/src/cors-options.ts` 에 `methods` 를 명시하고 `cors-options.test.ts` 가 프리플라이트를 직접 보낸다. 옵션에서 `methods` 를 지우는 결함 주입에서 3건이 `['GET','HEAD','POST']` 로 실패함을 확인했다.
2. **`@fastify/static` 의 `setHeaders` 는 raw 응답이 아니라 `FastifyReply` 를 받는다**(`res.setHeader` 없음). 옛 코드는 런타임에 `TypeError: res.setHeader is not a function` 이 나고 **요청이 에러 응답이 아니라 멈춘다**(시험에서 5초 타임아웃). `static.ts` 수정, `static.test.ts` 7건(캐시 헤더 2종·SPA 폴백·API 404·라우트 가림 방지·경로 탈출). 옛 방식으로 되돌리는 결함 주입에서 4건이 실패했다.
3. `setErrorHandler` 의 `err` 가 `unknown` 이 되어 시험 파일 6곳을 좁혔다(타입 오류로만 드러남).

**게이트.** `pnpm run audit:prod` = `pnpm audit --prod --audit-level=high`. CI 는 별도 `audit` job 으로 돌리고 **주 1회 스케줄**도 있다(코드 변경이 없어도 새 권고가 뜨기 때문). 별도 job 인 이유는 "시험이 깨졌다"와 "새 권고가 나왔다"를 한눈에 구분하기 위해서다. **high 이상·프로덕션 의존성만** 막는다 — moderate/low·개발 전용까지 막으면 CI 가 상시 빨개져 무시하게 된다. 게이트가 실제로 막는지 확인했다: 수정 전(HEAD) 락파일 exit 1, 수정 후 exit 0.

**검증 범위 (2026-09-19).**

| 항목 | 결과 |
|---|---|
| 정적 4단계(typecheck·lint·unit·build) | PASS. unit 464/464 (기존 450 + 신규 14), SKIP 0 |
| 실서버 HTTP 계층: 협업 WS·마켓·결제 웹훅(raw body)·OAuth 쿠키·웹 UI·bigdata API·다중 노드 협업 | 7단계 PASS |
| 보안(phase7) | PASS — 단, `TMPDIR` 를 `realpath` 로 정규화한 조건에서만 (아래 §7 위험 31) |
| 브라우저 e2e | **123 PASS / 3 skip / 0 FAIL** — **키 없는 서버**(`LOCAL_NO_AUTH=1`)에 대해서. 키 인증 서버에서는 7건이 실패한다(설정 불일치, HANDOFF §8) |
| Node 20.20.2 / 22.23.2 컨테이너에 새 플러그인 5종을 직접 설치·로드 | 각 6개 동작 검사 PASS (CORS DELETE 프리플라이트, 정적 캐시 헤더 2종, JSON raw-body 파서 교체, 쿠키, WebSocket) |

**하지 않은 것 / 알려진 공백.**
- **운영 이미지(`infra/Dockerfile`)를 빌드해 부팅하는 검증은 하지 못했다.** 이미지 빌드가 이번 변경과 무관하게 이미 깨져 있다(HANDOFF §7 위험 30). `phase8` 은 파괴적이라 실행하지 않았다.
- 개발 전용 의존성은 게이트 대상이 아니다. moderate/low 는 막지 않는다.
- `pnpm audit` 는 npm 권고 서비스의 가용성에 의존한다. 서비스 장애 시 job 이 실패할 수 있다.
- 권고의 실제 악용 가능성 시험(PoC)은 하지 않았다.
