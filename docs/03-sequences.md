# 5. Sequence Diagrams

## 5.1 채팅 + 도구 호출 + 메모리 (핵심 루프)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (VSCode/CLI)
  participant GW as Gateway
  participant O as Orchestrator
  participant M as Memory Engine
  participant R as RAG Retriever
  participant AR as AI Router
  participant P as Provider (선택된 LLM)
  participant T as Tool Engine
  participant DB as Postgres

  C->>GW: POST /v1/sessions/:id/messages (SSE)
  GW->>GW: auth + rate limit + token quota
  GW->>O: run(input)
  O->>DB: persist user message
  par 병렬 컨텍스트 수집
    O->>M: buildContext(session, query)
    M-->>O: {STM summary+window, LTM facts}
    O->>R: retrieve(query, projectId)
    R-->>O: top-k code chunks
  end
  O->>AR: stream(prompt, taskClass)
  AR->>AR: rank(후보 모델) → 1위 선택
  AR->>P: HTTP stream
  loop 스트리밍
    P-->>AR: delta
    AR-->>C: SSE text_delta
  end
  alt tool_calls 존재
    O->>T: execute(call) [정책 검사 → 샌드박스]
    T-->>O: result
    O->>DB: tool_invocations 기록
    O->>AR: 대화에 tool result 추가 후 재호출 (max 8턴)
  end
  O->>DB: persist assistant message + usage_events
  O->>O: enqueue memory-extraction job (비동기)
  Note over O: 파일 변경 시 git auto-commit
```

설계 포인트: 메모리/RAG 조회를 병렬화(3~4단계)해 첫 토큰 지연(TTFT)에 더해지는 오버헤드를 max(두 조회)로 억제. 메모리 추출은 응답 경로에서 제외(비동기 잡) — 사용자 지연에 LLM 추출 비용을 전가하지 않는다.

## 5.2 스트림 중 프로바이더 장애 → 폴백

```mermaid
sequenceDiagram
  participant AR as AI Router
  participant P1 as Claude (1순위)
  participant P2 as GPT (2순위)
  AR->>P1: stream request
  P1--xAR: 529 Overloaded (첫 토큰 전)
  AR->>AR: circuit breaker record, 후보 제거
  AR->>P2: 동일 요청 재시도
  P2-->>AR: 정상 스트림
  Note over AR: 첫 토큰이 이미 나간 뒤의 실패는<br/>폴백 불가 → 에러 이벤트로 정직하게 전달<br/>(이유: 모델이 바뀌면 이어쓰기 일관성이 깨짐)
```

## 5.3 코드베이스 인덱싱 (증분)

```mermaid
sequenceDiagram
  participant CLI as Client
  participant API as API
  participant Q as Queue (BullMQ)
  participant W as Worker
  participant E as Embedding (Router)
  participant PG as Postgres

  CLI->>API: POST /v1/projects/:id/index
  API->>Q: enqueue index job
  API-->>CLI: 202 {jobId}
  Q->>W: process
  W->>W: 파일 트리 walk (.gitignore 존중)
  W->>PG: 저장된 content_sha 로드
  W->>W: sha 비교 → 변경/신규/삭제 파일만 선별
  loop 변경 파일 배치
    W->>W: AST 경계 인식 청킹
    W->>E: embed(batch of 64)
    W->>PG: upsert code_chunks (트랜잭션: 파일 단위)
  end
  W->>API: progress via EventBus → WS push
```

파일 단위 sha 비교가 핵심: 저장 커밋마다 전체 재인덱싱하면 임베딩 비용이 프로젝트 크기에 비례해 반복 발생한다. 증분화로 일상 비용을 변경분에 비례하게 만든다.

## 5.4 플러그인 설치 (마켓플레이스)

```mermaid
sequenceDiagram
  participant U as User
  participant MP as Marketplace API
  participant ST as Storage (번들)
  participant H as Plugin Host

  U->>MP: POST /v1/plugins/:slug/install
  MP->>MP: manifest의 permissions 표시 → 사용자 승인 필요
  U->>MP: 승인 (granted_permissions)
  MP->>ST: 번들 다운로드
  MP->>MP: sha256 검증 + ed25519 서명 검증
  MP->>H: load(manifest, bundle)
  H->>H: worker_thread 격리 + capability bridge<br/>(승인된 권한만 노출)
  H-->>U: 플러그인 도구가 Tool Registry에 등록됨
```

## 5.5 실시간 협업 (Yjs relay)

```mermaid
sequenceDiagram
  participant A as Client A
  participant B as Client B
  participant W1 as WS Node 1
  participant W2 as WS Node 2
  participant R as Redis PubSub

  A->>W1: join doc:123
  B->>W2: join doc:123
  A->>W1: yjs update (binary, base64)
  W1->>R: PUBLISH collab:doc:123
  R->>W2: message
  W2->>B: yjs update
  Note over A,B: 서버는 CRDT를 해석하지 않음.<br/>수렴은 클라이언트 Yjs 병합이 보장 →<br/>WS 노드가 stateless, 수평 확장 자유
```
