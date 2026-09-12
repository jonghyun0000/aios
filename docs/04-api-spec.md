# 6. API 명세

**문서 성격:** 초기 설계와 후속 추가 기록이 함께 있다. 아래 예시의 자동 도구 실행·commit 이벤트·클라우드 인증을 현재 로컬 제품의 보장으로 해석하지 않는다. 실제 승인·검증·복구 계약은 [3단계 안전 실행](19-stage3-execution-safety.md), 현재 실행 범위는 [시작 안내](23-getting-started.md)를 우선 확인한다.

현재 사용자 시작기 Base URL: `http://127.0.0.1:8791` (일반 개발 서버 기본 포트: 8787). 공개 체험판에는 이 API가 없으며 개인 로컬 서버를 인터넷에 노출하지 않는다. 실제 운영 중인 공개 API 도메인은 제공하지 않는다.
인증: `Authorization: Bearer <supabase-jwt | aios_live_...>` — JWT는 사람(웹/확장), API 키는 기계(CLI/SDK/CI).
버저닝: URL prefix `/v1`. 파괴적 변경은 `/v2` 신설 + 12개월 병행. (이유: 헤더 버저닝은 캐시/프록시/디버깅에서 불투명)

## 2026-09-12 적용된 접근 경계

- 메시지 전송은 도구 사용 여부·응답 모드와 무관하게 member 이상이다. viewer는 자기 조직의 대화·자료·메모리 읽기를 유지하지만 메시지/세션/자료/메모리 쓰기는 403이다.
- 색인은 member 이상이며 `LOCAL_WORKSPACE_ROOT`와 그 폴더를 소유한 로컬 조직 안으로 제한한다. 설정 부재는 409, 외부 경로·다른 조직의 로컬 폴더 접근은 403이다. HTTP 접수와 실제 워커 읽기 시점 모두 검사한다.
- 새 `/v1/collab`은 member 이상만 참가한다. viewer는 4403, 인증 실패는 4401로 종료한다. viewer용 읽기 전용 Yjs 협업은 구현하지 않았다.
- 구형 `/v1/ws`의 읽기 구독/ping은 viewer도 사용할 수 있고 `collab.update` 쓰기만 거부한다. 이 구형 릴레이는 아직 코드에 남아 있다.
- 요청 로그에는 query 전체를 남기지 않는다. URL token 전송 방식 자체와 외부 프록시 로그까지 해결한 것은 아니다. [보안 보완 근거](22-project-scorecard.md)를 함께 확인한다.

## 6.1 REST

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | /healthz | liveness | 공개 |
| GET | /v1/me | 현재 사용자/조직 | viewer |
| POST | /v1/sessions | 세션 생성 `{projectId?, title?}` | member |
| GET | /v1/sessions | 세션 목록 (cursor 페이지네이션) | viewer |
| POST | /v1/sessions/:id/messages | **메시지 전송, SSE 스트림 응답** | member |
| GET | /v1/sessions/:id/messages | 히스토리 | viewer |
| POST | /v1/projects | 프로젝트 생성 | admin |
| POST | /v1/projects/:id/index | 인덱싱 트리거 → 202 {jobId} | member |
| GET | /v1/projects/:id/search?q=&k= | 하이브리드 코드 검색 (RAG) | viewer |
| GET | /v1/jobs/:id | 잡 상태 | member |
| GET | /v1/memory?q=&scope= | LTM 조회 | viewer |
| POST | /v1/memory | 명시적 기억 저장 | member |
| DELETE | /v1/memory/:id | 기억 삭제 (GDPR) | member |
| GET | /v1/models | 라우터 카탈로그 + 헬스 | viewer |
| GET | /v1/plugins | 마켓플레이스 목록 | member |
| POST | /v1/plugins/:slug/install | 설치 (권한 승인 포함) | admin |
| GET | /v1/usage | 기간별 사용량/비용 | admin |
| POST | /v1/billing/webhook | Stripe 웹훅 (서명 검증) | Stripe만 |

## 6.2 메시지 전송 (핵심 엔드포인트)

```
POST /v1/sessions/:id/messages
Content-Type: application/json
Accept: text/event-stream
```
```json
{
  "content": "이 함수 리팩토링해줘",
  "routing": { "taskClass": "code", "model": null, "maxCostUsd": 0.5 },
  "tools": { "enabled": true, "policy": "auto" },
  "context": { "files": ["src/user.ts"], "useRag": true, "useMemory": true }
}
```

SSE 이벤트 (모두 `data: <json>\n\n`):
```
{"type":"routed","provider":"anthropic","model":"claude-sonnet-4-5"}
{"type":"text_delta","text":"먼저 "}
{"type":"tool_start","call":{"id":"t1","name":"read_file","arguments":{"path":"src/user.ts"}}}
{"type":"tool_result","id":"t1","ok":true}
{"type":"commit","sha":"a1b2c3d","message":"aios: refactor user service"}
{"type":"usage","inputTokens":4210,"outputTokens":890,"costUsd":0.0182}
{"type":"done","stopReason":"end_turn"}
```

에러 응답(비스트림)은 RFC 7807 스타일:
```json
{ "error": { "code": "quota_exceeded", "message": "...", "retryable": false } }
```

## 6.3 WebSocket 프로토콜 (`/v1/ws?token=`)

| 클라이언트 → 서버 | 서버 → 클라이언트 |
|---|---|
| `{"t":"sub","ch":"session:ID"}` | `{"t":"event","ch":"...","ev":{...}}` (인덱싱 진행률, 세션 이벤트) |
| `{"t":"collab.join","doc":"D"}` | `{"t":"collab.update","doc":"D","u":"<base64>"}` |
| `{"t":"collab.update","doc":"D","u":"<base64>"}` | `{"t":"collab.presence","doc":"D","peers":[...]}` |
| `{"t":"ping"}` | `{"t":"pong"}` |

이유 — SSE와 WS를 둘 다 쓰는 근거: 채팅 응답은 단방향 스트림이라 SSE가 단순하고(HTTP 인프라 그대로 통과, 자동 재연결) 프록시 친화적. 협업/이벤트 구독은 양방향이라 WS. "전부 WS"로 통일하면 채팅 요청까지 상태ful해져 LB/재시도 설계가 복잡해진다.

## 6.4 SDK 계약

SDK(`@aios/sdk`)는 이 명세의 타입을 `packages/shared`에서 그대로 가져온다. 서버와 SDK가 같은 타입을 컴파일하므로 명세 드리프트가 빌드 타임에 잡힌다.

---

## Sprint #3 추가 엔드포인트

### 실시간 협업

| 메서드 | 경로 | 설명 |
|---|---|---|
| WS | `/v1/collab?doc=<id>&token=<key>` | Yjs 바이너리 동기화. 프레이밍은 y-websocket 표준(`[varUint type, ...payload]`, 0=sync, 1=awareness) |

close 코드: `4400` doc 파라미터 누락 · `4401` 인증 실패 · `4403` member 역할 미달 · `1007` 잘못된 프레임 · `1009` 1MB 초과.
기존 `/v1/ws`는 이벤트 구독과 구형 JSON 릴레이를 유지한다. 새 Yjs 바이너리 문서는 별도 경로를 쓴다.

### 마켓플레이스

| 메서드 | 경로 | 최소 역할 | 설명 |
|---|---|---|---|
| GET | `/v1/marketplace/plugins` | member | 검색 (`q`, `sort=downloads\|recent\|relevance`, `limit`, `offset`) |
| GET | `/v1/marketplace/plugins/:slug` | member | 상세 + 버전 목록 (pending은 소유 조직에만) |
| POST | `/v1/marketplace/plugins` | admin | 게시. 서명 시 자동 승인, 무서명은 pending |
| POST | `/v1/marketplace/plugins/:slug/versions/:version/review` | owner + 심사 조직 | approve / reject / yank |
| POST | `/v1/marketplace/plugins/:slug/install` | admin | 설치. 버전 미지정 시 승인된 최신 |
| DELETE | `/v1/marketplace/plugins/:slug/install` | admin | 제거 |
| GET | `/v1/marketplace/installed` | member | 설치 목록 |
| PUT | `/v1/marketplace/plugins/:slug/rating` | 사용자 신원 필요 | 1~5점. 설치한 조직만 |
| POST | `/v1/marketplace/plugins/:slug/verify` | member | 번들 sha256 재확인 (불일치 시 409) |

### 결제

| 메서드 | 경로 | 최소 역할 |
|---|---|---|
| GET | `/v1/billing/plans` | member |
| GET | `/v1/billing/subscription` | member (구독 + 현재 주기 사용량) |
| POST | `/v1/billing/checkout` | owner (Stripe Checkout URL 반환) |
| POST | `/v1/billing/portal` | owner (고객 포털 URL) |
| POST | `/v1/billing/cancel` | owner (기본: 기간 만료 시 해지) |
| POST | `/v1/billing/webhook` | 공개 — 서명이 곧 인증 |

웹훅 응답에 `outcome`(`applied` / `duplicate` / `ignored` / `unmatched`)을 담는다.
`unmatched`는 서명은 맞으나 조직 매칭에 실패한 경우로, 200을 반환하되 `log.error`를 남긴다.

### OAuth

| 메서드 | 경로 | 인증 |
|---|---|---|
| GET | `/v1/auth/providers` | 공개 (설정된 프로바이더만 나열) |
| GET | `/v1/auth/:provider/start` | 공개 (`redirect_to`, `mode=redirect\|json`) |
| GET | `/v1/auth/:provider/callback` | 공개 (IdP가 호출) |
| GET | `/v1/auth/session` | 세션 토큰 |
| POST | `/v1/auth/logout` | 세션 토큰 |

세션 토큰은 `aios_sess_` 접두사를 가지며, `Authorization: Bearer`와 HttpOnly 쿠키
(`aios_session`) 양쪽으로 받는다. 일반 API 라우트에서도 그대로 인증 수단이 된다.
