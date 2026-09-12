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
