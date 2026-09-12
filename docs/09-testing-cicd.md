# 16. 테스트 전략 & 17. CI/CD

## 16. 테스트 전략

LLM 시스템의 테스트는 결정론 계층과 비결정론 계층을 분리하는 것이 전부다.

| 계층 | 대상 | 도구 | 게이트 |
|---|---|---|---|
| Unit | 라우터 점수화, 서킷브레이커, 프롬프트 예산 할당, 청커, SSE 파서 | vitest | PR 필수, <30s |
| Contract | 프로바이더 어댑터 ↔ 실제 API 스키마 | 녹화된 SSE 픽스처 재생(신규 녹화는 주간 크론) | PR 필수 |
| Integration | Memory/Indexer/Queue ↔ 실제 PG+Redis | vitest + CI 서비스 컨테이너 | PR 필수 |
| E2E | CLI→API→(모킹 LLM)→도구→커밋 전체 루프 | 시나리오 테스트, LLM은 스크립트 응답 | main 머지 시 |
| **Eval (품질 회귀)** | 라우팅 결정 품질, RAG recall@k, 메모리 recall 정확도, 에이전트 태스크 성공률(SWE-bench 스타일 내부 셋 50태스크) | 자체 eval 하네스, 야간 실행 | 점수 하락 시 알림(차단 아님) |
| Load | SSE 동시 스트림 5k, WS 팬아웃 | k6 | 릴리스 전 |
| Security | 의존성 감사, 프롬프트 인젝션 시나리오 셋, 샌드박스 탈출 시도 셋 | osv-scanner + 자체 레드팀 스위트 | 주간 |

핵심 원칙:
1. **LLM 호출은 unit/integration에서 절대 실제로 하지 않는다** — 비용·플레이크·속도 모두 악화. 어댑터 경계에서 픽스처로 자른다.
2. **Eval은 CI 차단 게이트가 아니다** — LLM 품질 점수는 노이즈가 커서 차단 게이트로 쓰면 개발이 멈춘다. 추세 모니터링 + 임계 하락 시 사람 판단.
3. 프롬프트 변경은 코드 리뷰 대상 + eval diff 첨부를 관례화.

## 17. CI/CD

파이프라인: [.github/workflows/ci.yml](../.github/workflows/ci.yml)

```
PR: typecheck → lint → unit/contract/integration (서비스 컨테이너 PG+Redis, 마이그레이션 적용 포함)
main: 위 전체 → docker build (api/worker, GHA 캐시) → ghcr push
     → staging 자동 배포 → smoke test
     → production: 수동 승인 게이트 → canary 10% (5분, error rate < 0.5%) → 100%
```

- **마이그레이션은 배포 전 단계에서 별도 잡으로 실행**, 롤백 호환(추가만, 파괴적 변경은 2단계 배포: expand → migrate → contract). 이유: 앱 롤백 시 스키마가 구버전 코드와 호환되어야 한다.
- VSCode 확장은 별도 릴리스 트랙(vsce publish, 시맨틱 버전 태그 트리거) — 서버와 확장의 배포 주기를 분리해야 확장 심사 지연이 서버 릴리스를 막지 않는다.
- 카나리 지표: 5xx율, SSE 스트림 중단율, TTFT p95. LLM 프록시 특성상 **스트림 중단율**이 일반 5xx보다 민감한 조기 신호다.
