# 7. Plugin 구조 & Marketplace

## 7.1 설계 철학

플러그인은 **capability 모델**을 따른다: 플러그인은 아무것도 할 수 없는 상태로 시작하고, manifest에 선언하고 사용자가 승인한 권한만 bridge를 통해 주입받는다. OS의 syscall 모델과 동일 — 이것이 "AI 운영체제"에서 서드파티 코드를 안전하게 실행하는 유일한 방법이다.

## 7.2 Manifest (`plugin.json`)

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "displayName": "Hello World",
  "description": "Example plugin",
  "entry": "dist/index.js",
  "engines": { "aios": ">=0.1.0" },
  "permissions": ["tools.register", "net.fetch:api.github.com", "storage.kv"],
  "contributes": {
    "tools": [{ "name": "gh_stars", "description": "Get repo stars" }]
  }
}
```

권한 어휘:
- `tools.register` — Tool Registry에 도구 등록
- `net.fetch:<host>` — 특정 호스트만 아웃바운드 (와일드카드 금지: 데이터 유출 방지)
- `storage.kv` — 플러그인 전용 네임스페이스 KV
- `events.subscribe:<topic>` — EventBus 구독
- `fs.read` / `fs.write` — 프로젝트 루트 내부만 (path jail)

## 7.3 실행 격리

```
Plugin Host (main)                    worker_thread (per plugin)
┌──────────────────┐  postMessage    ┌─────────────────────────┐
│ capability bridge │ ←────────────→ │ plugin bundle           │
│ - 권한 필터       │   RPC(JSON)    │ globalThis.aios = proxy  │
│ - rate limit      │                │  .tools.register(...)   │
│ - audit log       │                │  .fetch(...)  ← 호스트가 │
└──────────────────┘                │     허용 host만 대행     │
                                     └─────────────────────────┘
```

worker_thread 선택 이유: 프로세스 격리(V8 isolate 공유 없음)보다 가볍고, 메시지 기반 RPC를 강제하므로 플러그인이 호스트 메모리에 직접 접근할 수 없다. `fetch`·`fs` 같은 위험 API는 워커에 직접 주지 않고 **호스트가 대행**한다 — 워커 안에서 `require('fs')`가 되더라도 프로덕션에서는 `--experimental-permission` + 번들 정적 검사로 이중 차단. 고위험 테넌트용 로드맵: 플러그인별 microVM.

## 7.4 Marketplace 파이프라인

1. 개발자: `aios plugin publish` → 번들 업로드 + sha256 + 개발자 키로 ed25519 서명
2. 레지스트리: 정적 분석(금지 API 스캔, 의존성 감사) → `pending`
3. 리뷰(자동+수동) → `approved`
4. 설치 시: 해시·서명 재검증 → 권한 동의 UI → `plugin_installs`에 granted_permissions 기록
5. 런타임: bridge는 **granted** 권한만 노출 (manifest 선언보다 좁을 수 있음)

번들 서명을 레지스트리 서명이 아닌 **개발자 서명**으로 한 이유: 레지스트리가 침해당해도 기존 설치 사용자에게 악성 업데이트를 밀어넣을 수 없다 (TOFU + 키 고정).

## 7.5 VSCode 확장과의 관계

VSCode 확장은 플러그인이 아니라 1급 클라이언트다. 플러그인 도구는 서버 측 Tool Registry에 등록되므로, VSCode/CLI/웹 어디서든 동일하게 동작한다 — 클라이언트별 플러그인 이식 문제가 원천적으로 없다.
