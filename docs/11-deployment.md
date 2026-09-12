# AIOS 배포 가이드

이 문서의 모든 명령은 **실제로 실행해 검증한 것**이다. 검증하지 않은 부분은 명시적으로 표시했다.

배포 경로는 셋 중 하나를 고른다:

| 경로 | 적합한 상황 | 필요한 것 | 소요 |
|---|---|---|---|
| **A. 단일 서버 (Docker Compose)** | 팀 내부용, 사용자 ~100명, 운영 인력 없음 | VM 1대 (4vCPU / 8GB) | 30분 |
| **B. Kubernetes (Helm)** | 프로덕션, 무중단 배포·카나리·롤백 필요 | k8s 클러스터, 관리형 DB 권장 | 2~4시간 |
| **C. 관리형 서비스 조합** | 인프라 운영을 최소화하고 싶을 때 | Supabase + Upstash + Fly.io/Render | 1시간 |

**어느 경로든 §0(사전 준비)과 §5(운영)는 공통이다.**

---

## 0. 사전 준비 (모든 경로 공통)

### 0.1 필요한 것

| 항목 | 필수 | 비고 |
|---|---|---|
| LLM 프로바이더 키 1개 이상 | ✅ | 하나도 없으면 **서버가 부팅을 거부한다**(의도된 동작 — §5.6) |
| PostgreSQL 16+ with pgvector | ✅ | 15 이하는 pgvector HNSW 성능이 떨어진다 |
| Redis 7+ | ✅ | STM·큐·PubSub 공용 |
| 도메인 + TLS 인증서 | 경로 B/C | SSE가 HTTP/1.1 keep-alive를 오래 유지하므로 TLS 종단 설정이 중요(§2.5) |
| Docker 이미지 레지스트리 | 경로 B | GHCR 기본 |
| Stripe 계정 | ❌ | 과금 안 쓰면 생략 |
| Supabase 프로젝트 | ❌ | OAuth 안 쓰면 API 키 인증만으로 동작 |

### 0.2 환경변수 전체 목록

`.env.example`이 원본이다. 값의 의미:

```bash
# --- 필수 ---
DATABASE_URL=postgres://user:pass@host:5432/aios   # 부팅 시 연결 확인, 실패하면 기동 거부
REDIS_URL=redis://host:6379
PORT=8787
NODE_ENV=production

# --- LLM 프로바이더 (최소 1개 필수) ---
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...        # 임베딩에도 쓰인다 (§0.3)
GEMINI_API_KEY=...
XAI_API_KEY=xai-...

# --- 선택 ---
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_JWT_SECRET=...       # 없으면 JWT 인증 비활성, API 키 인증만 동작
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SANDBOX_IMAGE=ghcr.io/you/aios/sandbox:latest
GIT_SHA=<배포 커밋>            # /healthz 의 version 필드에 노출
```

### 0.3 임베딩 프로바이더는 별도 판단이 필요하다

**Anthropic은 임베딩 API를 제공하지 않는다.** 라우터는 임베딩에 OpenAI → Gemini 순으로 폴백한다.

| 키 조합 | 채팅 | 코드 인덱싱·RAG·장기기억 recall |
|---|---|---|
| Anthropic만 | 동작 | **동작하지 않음** (`no_embedder` 에러) |
| Anthropic + OpenAI | 동작 | 동작 |
| OpenAI만 | 동작 | 동작 |

RAG와 장기기억을 쓸 계획이면 **OpenAI 또는 Gemini 키를 반드시 함께** 넣어야 한다.

### 0.4 배포 전 체크리스트

```bash
git clone <repo> && cd aios
pnpm install --frozen-lockfile
pnpm verify        # 12단계 전부 통과해야 배포한다
```

`pnpm verify`의 종료 코드: `0`=통과, `1`=제품 실패(배포 금지), `2`=환경 차단(프로바이더 크레딧 등 — 제품 문제 아님).

---

## 경로 A — 단일 서버 (Docker Compose)

가장 빠르고, 실제로 전 구성요소가 뜨는 것을 검증했다.

### A.1 서버 준비

```bash
# Ubuntu 22.04/24.04 기준
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker
```

권장 사양: **4 vCPU / 8GB RAM / 40GB SSD**. 근거 — 실측 리소스는 API가 heap 26MB/rss 168MB로 매우 작지만, Postgres(pgvector 인덱스)와 코드 인덱싱 워커가 메모리를 쓴다.

### A.2 배포

```bash
git clone <repo> aios && cd aios
cp .env.example .env
# .env 를 편집해 실제 키를 넣는다. 최소: DATABASE_URL, REDIS_URL, 프로바이더 키 1개
$EDITOR .env

# 샌드박스 이미지 먼저 (run_command 도구가 사용)
docker build -f infra/sandbox.Dockerfile -t aios-sandbox:latest .

# 전체 스택 기동. migrate가 완료된 뒤에야 api/worker가 뜬다.
docker compose up -d --build
```

compose는 `postgres(healthy) → migrate(완료) → api/worker` 순서를 강제한다. 마이그레이션을 앱 부팅에 섞지 않는 이유: 앱 인스턴스가 N개면 N개가 동시에 마이그레이션을 시도하고, 롤백 시 스키마와 코드 버전이 어긋난다.

### A.3 확인

```bash
docker compose ps                    # 4개 서비스가 healthy/Up
curl -s localhost:8787/readyz        # {"ready":true,...}
docker compose logs migrate | tail   # "migrations up to date"
```

### A.4 첫 사용자 만들기

```bash
DATABASE_URL="postgres://aios:aios@localhost:5432/aios" node scripts/seed-dev.mjs
```

출력의 `apiKey`는 **이때 한 번만** 볼 수 있다(DB에는 sha256 해시만 저장). 안전한 곳에 보관한다.

```bash
KEY=aios_live_...
curl -s localhost:8787/v1/me -H "authorization: Bearer $KEY"
```

### A.5 리버스 프록시 + TLS

Caddy가 가장 간단하다. **SSE 때문에 버퍼링을 반드시 꺼야 한다.**

```caddyfile
# /etc/caddy/Caddyfile
api.example.com {
    reverse_proxy localhost:8787 {
        flush_interval -1        # SSE 필수: 응답을 버퍼링하지 않고 즉시 흘린다
        transport http {
            read_timeout 3600s   # 긴 스트림이 끊기지 않도록
            write_timeout 3600s
        }
    }
}
```

nginx를 쓴다면:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;          # WebSocket(협업) 업그레이드에 필요
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;             # SSE 필수
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

> `proxy_buffering off`를 빠뜨리면 스트리밍이 "한 번에 뭉쳐서" 도착한다. 기능은 동작하는 것처럼 보이지만 사용자 체감은 완전히 망가진다 — 가장 흔한 배포 실수다.

### A.6 업데이트

```bash
cd aios && git pull
docker compose up -d --build    # migrate가 먼저 돌고, 그다음 api/worker 교체
```

Compose의 롤링 업데이트는 순간적인 단절이 있다. **무중단이 필요하면 경로 B**를 쓴다.

---

## 경로 B — Kubernetes (Helm)

`infra/helm` 차트를 로컬 kind 클러스터에 **실제 배포해 검증**했다: 설치, 롤링 업데이트(무중단 400/400), 롤백(무중단 300/300), 카나리, 마이그레이션 훅.

### B.1 클러스터 요구사항

- Kubernetes 1.27+
- Ingress 컨트롤러 (ingress-nginx 기준으로 annotation 작성됨)
- `metrics-server` (HPA를 쓸 경우)
- **PostgreSQL·Redis는 클러스터 밖 관리형 서비스 권장** — 상태를 가진 것을 직접 운영하는 비용이 가장 크다

노드 리소스: API 파드가 기본 250m CPU를 요청하므로, replica 2 + worker 2 + 마이그레이션 Job이 동시에 들어갈 여유가 필요하다. 단일 노드 클러스터에서는 **마이그레이션 Job이 스케줄되지 못해 배포가 그 자리에서 멈추는** 상황을 실제로 겪었다(§B.7).

### B.2 이미지 빌드·푸시

차트는 `{repository}/api`, `/worker`, `/migrate` 세 이미지를 사용한다. **세 개를 모두 푸시해야 한다** — migrate를 빠뜨리면 Helm의 pre-upgrade 훅이 ImagePullBackOff로 멈춘다.

```bash
REG=ghcr.io/OWNER/REPO
TAG=$(git rev-parse HEAD)

for t in api worker migrate; do
  docker build -f infra/Dockerfile --target $t -t "$REG/$t:$TAG" .
  docker push "$REG/$t:$TAG"
done

# 샌드박스 이미지 (도구 실행용)
docker build -f infra/sandbox.Dockerfile -t "$REG/sandbox:$TAG" . && docker push "$REG/sandbox:$TAG"
```

CI(`.github/workflows/ci.yml`)가 main 푸시마다 이 세 개를 자동으로 만든다.

### B.3 시크릿

차트는 시크릿을 **담지 않는다**. 아래 이름의 Secret이 미리 존재해야 한다.

```bash
kubectl create namespace prod

kubectl -n prod create secret generic aios-secrets \
  --from-literal=DATABASE_URL='postgres://user:pass@db-host:5432/aios' \
  --from-literal=REDIS_URL='redis://redis-host:6379' \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-...' \
  --from-literal=OPENAI_API_KEY='sk-...' \
  --from-literal=SUPABASE_JWT_SECRET='...' \
  --from-literal=STRIPE_WEBHOOK_SECRET='whsec_...'
```

프로덕션에서는 위 명령을 직접 쓰지 말고 External Secrets Operator / Sealed Secrets / SOPS 중 하나로 관리한다. 어느 것을 쓰든 **결과물은 `aios-secrets`라는 이름의 Secret**이면 된다.

> 차트는 Secret 이름의 해시를 파드 annotation에 넣는다. 키를 교체한 뒤 파드를 새로 뜨게 하려면 `kubectl -n prod rollout restart deploy/aios-aios-api` 를 실행한다(env는 런타임에 갱신되지 않는다).

### B.4 설치

```bash
helm upgrade --install aios ./infra/helm -n prod --create-namespace \
  --set image.repository=$REG \
  --set image.tag=$TAG \
  --set ingress.host=api.example.com \
  --set ingress.tls.secretName=aios-tls \
  --set config.SANDBOX_IMAGE=$REG/sandbox:$TAG \
  --wait --timeout 10m
```

`image.tag`를 비우면 **차트가 배포를 거부한다**. `latest`를 암묵적으로 허용하면 어떤 커밋이 떠 있는지 알 수 없어 롤백이 불가능해지기 때문이다.

설치 순서(차트가 강제):
1. `pre-install` 훅으로 **마이그레이션 Job** 실행 → 실패하면 여기서 중단, 앱은 뜨지 않는다
2. API Deployment(2 replica) + Worker Deployment
3. Service, Ingress, HPA, PodDisruptionBudget

### B.5 확인

```bash
kubectl -n prod get pods
kubectl -n prod rollout status deploy/aios-aios-api

# 클러스터 내부에서 Service를 통해 확인 (실제 트래픽과 같은 경로)
kubectl -n prod run smoke --rm -i --restart=Never --image=curlimages/curl:8.10.1 \
  --command -- curl -fsS http://aios-aios-api/readyz
```

> `kubectl port-forward`로 무중단을 측정하지 말 것. port-forward는 **특정 파드에 고정**되어 롤아웃 중 그 파드가 교체되면 끊긴다 — 실제로는 무중단인데 321/400 실패로 잘못 측정한 적이 있다. 반드시 클러스터 내부 프로브로 측정한다.

### B.6 무중단 업데이트

```bash
NEW=$(git rev-parse HEAD)
helm upgrade aios ./infra/helm -n prod --reuse-values --set image.tag=$NEW --wait --timeout 10m
```

무중단을 보장하는 장치 4가지(전부 차트에 반영):

| 장치 | 역할 |
|---|---|
| `maxUnavailable: 0` | 새 파드가 Ready가 되기 전에는 기존 파드를 내리지 않는다 |
| `readinessProbe: /readyz` | DB·Redis 왕복이 성공해야 트래픽을 받는다 |
| `preStop: sleep 5` | 엔드포인트 갱신 시차 동안 들어오는 요청을 정상 처리 |
| `terminationGracePeriodSeconds: 30` | SIGTERM 후 in-flight SSE 스트림이 끝날 때까지 대기(앱은 25초 데드라인) |

**검증 결과**: 롤링 업데이트 중 클러스터 내부에서 400회 요청, **실패 0건**.

### B.7 카나리

```bash
# 새 버전을 트래픽 일부에만
helm upgrade aios ./infra/helm -n prod --reuse-values \
  --set canary.weight=10 --set canary.tag=$NEW --wait

# 지켜본다
kubectl -n prod logs -l aios.dev/track=canary --tail=100 -f
kubectl -n prod get pods -l aios.dev/track=canary   # RESTARTS가 늘면 문제

# 좋으면 전체 승격
helm upgrade aios ./infra/helm -n prod --reuse-values \
  --set image.tag=$NEW --set canary.weight=0 --wait

# 나쁘면 카나리만 제거 (stable은 건드리지 않는다)
helm upgrade aios ./infra/helm -n prod --reuse-values --set canary.weight=0 --wait
```

**한계(정직히)**: 실제 비율은 `카나리 파드 수 / 전체 엔드포인트 수`다. replica가 적으면 거칠다 — 실측에서 stable 2 + canary 1이면 `weight=10`을 줘도 실제로는 약 33%였다. 정밀한 비율이 필요하면 replica를 늘리거나(stable 9 + canary 1 = 10%) ingress-nginx의 canary annotation 또는 서비스 메시로 옮긴다.

### B.8 롤백

```bash
helm history aios -n prod
helm rollback aios -n prod            # 직전 리비전으로
helm rollback aios -n prod 3          # 특정 리비전으로
```

**롤백이 안전한 이유(검증됨)**:
- 마이그레이션이 **추가 전용**이다(DROP TABLE / DROP COLUMN / 타입 변경 없음) → 구버전 앱이 새 스키마를 그대로 읽는다
- 마이그레이션 러너가 `schema_migrations`로 적용 이력을 추적 → 재실행이 no-op
- 이전 이미지를 현재 스키마 위에서 기동해 트래픽 처리까지 확인했다

**검증 결과**: 롤백 중 클러스터 내부에서 300회 요청, **실패 0건**.

> 스키마를 파괴적으로 바꿔야 한다면 2단계로 나눈다: ① 새 컬럼 추가 + 양쪽 코드가 모두 동작하는 버전 배포 → ② 구 컬럼 제거. 한 번에 하면 롤백이 불가능해진다.

### B.9 흔한 실패와 원인

| 증상 | 원인 | 조치 |
|---|---|---|
| migrate Job이 `Pending`에서 멈춤 | 노드 CPU 부족. pre-upgrade 훅이라 **배포 전체가 정지** | `--set migration.resources.requests.cpu=50m` 로 낮추거나 노드 증설 |
| `CreateContainerConfigError` | `runAsNonRoot`인데 `runAsUser` 미지정 | 차트는 이미 uid 1000을 명시. 커스텀 이미지를 쓴다면 숫자 UID 필요 |
| `ImagePullBackOff` (migrate만) | migrate 이미지를 푸시하지 않음 | 세 이미지를 모두 푸시(§B.2) |
| 파드가 `CrashLoopBackOff`, 로그에 `no LLM provider key found` | 프로바이더 키 미설정 | **의도된 동작.** Secret에 키 추가 후 재시작 |
| 로그에 `cannot reach Postgres at boot` | DB 미도달 | DSN·네트워크 정책 확인. 부팅에서 잡히는 것이 첫 요청에서 잡히는 것보다 낫다 |
| 스트리밍이 뭉쳐서 도착 | Ingress 버퍼링 | `nginx.ingress.kubernetes.io/proxy-buffering: "off"` (차트 기본값에 포함) |

---

## 경로 C — 관리형 서비스 조합

인프라 운영을 최소화한다. 데이터 계층만 관리형으로 옮기고 앱은 A나 B로 배포한다.

| 구성요소 | 서비스 | 설정 |
|---|---|---|
| PostgreSQL + pgvector | **Supabase** | Dashboard → Database → Extensions에서 `vector` 활성화 후 `DATABASE_URL`에 connection pooler 주소(포트 6543) 사용 |
| Redis | **Upstash** | `REDIS_URL=rediss://...` (TLS). BullMQ가 TLS를 지원한다 |
| 앱 | Fly.io / Render / Railway | Dockerfile의 `api`/`worker` 타깃을 각각 별도 서비스로 |
| 오브젝트 스토리지 | Supabase Storage / S3 | 플러그인 번들·백업 |

Supabase를 쓰면 OAuth도 함께 얻는다: `SUPABASE_URL`, `SUPABASE_JWT_SECRET`을 넣으면 JWT 인증이 활성화된다.

**마이그레이션은 별도로 한 번 실행해야 한다**:
```bash
DATABASE_URL='postgres://...supabase...' node scripts/migrate.mjs
```

> ⚠️ **미검증**: 경로 C의 조합은 실제로 배포해 보지 않았다. 개별 요소(Supabase 스타일 DSN, pgvector, TLS Redis)는 표준이지만, 이 조합 전체의 동작은 확인되지 않았다.

---

## 5. 운영 (모든 경로 공통)

### 5.1 헬스 엔드포인트 세 개의 역할이 다르다

| 엔드포인트 | 질문 | 의존성 확인 | 용도 |
|---|---|---|---|
| `/healthz` | 프로세스가 살아 있는가 | **하지 않음** | liveness probe |
| `/readyz` | 트래픽을 받을 준비가 됐는가 | PG·Redis 왕복 | readiness probe, LB |
| `/metrics` | 지표 | — | Prometheus |

**`/healthz`가 의존성을 확인하지 않는 것은 의도다.** DB가 잠깐 흔들렸다고 파드를 재시작하면 장애가 증폭된다(재시작 폭풍). 의존성 장애의 올바른 반응은 "재시작"이 아니라 "LB에서 빠지기"이고, 그것이 `/readyz`의 역할이다.

세 엔드포인트는 인증 없이 열려 있다 — LB와 Prometheus는 자격증명을 들고 오지 않는다. 대신 민감 정보를 담지 않으며, 네트워크 정책으로 클러스터 내부에서만 접근하게 하는 것을 권장한다. `/v1/*` API는 여전히 인증을 강제한다(검증: 401).

### 5.2 모니터링 — 무엇을 볼 것인가

`/metrics`가 노출하는 것 중 **실제로 알람을 걸 값**:

| 지표 | 알람 조건 | 이유 |
|---|---|---|
| `aios_model_circuit_open` | `> 0` 이 5분 지속 | 프로바이더 장애. 폴백이 동작 중이지만 비용·품질이 변한다 |
| `aios_pg_pool_waiting` | `> 0` 이 1분 지속 | 커넥션 고갈 임박. pgbouncer 도입 신호 |
| `aios_model_success_rate` | `< 0.95` | 프로바이더 품질 저하 |
| `aios_heap_bytes` | 지속 증가 | 누수 의심 (실측 정상치: 900턴에 623 bytes/turn) |
| `aios_model_latency_ms` | 평소의 2배 | 프로바이더 지연 |

**LLM 앱 특유의 지표 하나**: 일반 5xx율보다 **SSE 스트림 중단율**이 더 민감한 조기 신호다. 5xx는 요청이 시작도 못 한 경우만 잡지만, 스트림 중단은 "응답하다 끊긴" 사용자 체감 실패를 잡는다.

Prometheus Operator를 쓴다면:
```bash
helm upgrade aios ./infra/helm -n prod --reuse-values --set metrics.serviceMonitor.enabled=true
```

### 5.3 로그

구조화 JSON(pino). 각 레코드에 `reqId`가 있어 요청 단위로 추적 가능하다.

```bash
# 특정 요청 추적
kubectl -n prod logs -l app.kubernetes.io/component=api | jq 'select(.reqId=="req-42")'
# 에러만
kubectl -n prod logs -l app.kubernetes.io/component=api | jq 'select(.level>=50)'
```

수집기(Loki/CloudWatch/Datadog)에 보낼 때 `reqId`, `orgId`를 인덱스 필드로 잡으면 조사 속도가 크게 달라진다.

### 5.4 백업

```bash
DATABASE_URL='postgres://...' BACKUP_DIR=/var/backups/aios \
  BACKUP_S3_URI='s3://my-bucket/aios' RETENTION_DAYS=30 \
  bash scripts/backup.sh
```

스크립트가 하는 일: 논리 덤프 → **복원 가능성 검증**(`pg_restore --list`) → S3 업로드 → 오래된 로컬 파일 정리.

**클라이언트 버전이 서버보다 높으면 스크립트가 거부한다.** PG17 클라이언트로 뜬 덤프는 PG16 서버에서 복원되지 않는다(`transaction_timeout` 미인식) — 실제로 겪은 문제다. 복원 불가능한 백업은 없는 백업보다 나쁘다(거짓 안심을 준다). 서버와 같은 메이저 버전 클라이언트를 쓰거나, 컨테이너 안에서 실행한다:

```bash
docker compose exec -T postgres pg_dump --format=custom --no-owner \
  "postgres://aios:aios@localhost:5432/aios" > backup.dump
```

cron 예시(매일 03:00):
```
0 3 * * * cd /opt/aios && DATABASE_URL=... BACKUP_S3_URI=s3://... bash scripts/backup.sh >> /var/log/aios-backup.log 2>&1
```

**Redis는 백업하지 않는다.** STM은 TTL로 소멸하는 캐시이고 큐는 재생성 가능하다. 유실되면 안 되는 것은 전부 Postgres에 있다 — 아키텍처의 의도된 결과다.

### 5.5 복원 (실제 왕복 검증됨)

```bash
# 기본: 새 DB로 복원 (기존 DB를 건드리지 않는다)
DATABASE_URL='postgres://host:5432/postgres' bash scripts/restore.sh backup.dump

# 기존 DB에 덮어쓰기 — 실제로 존재할 때만 --force 를 요구한다
RESTORE_TARGET=aios DATABASE_URL='postgres://host:5432/postgres' \
  bash scripts/restore.sh backup.dump --force
```

복원 후 스크립트가 확인하는 것: public 테이블 수(≥10), pgvector 확장 존재. **검증 결과**: 19개 테이블 + pgvector + 시드 데이터 복원 성공.

정기적으로 **복원 훈련**을 한다. 복원해 본 적 없는 백업은 백업이 아니다.

### 5.6 의도적으로 "실패하게" 만든 것들

배포 중 이런 상황을 만나면 버그가 아니라 설계다:

| 상황 | 동작 | 이유 |
|---|---|---|
| 프로바이더 키가 하나도 없음 | **부팅 거부**(크래시루프) | 그냥 뜨면 파드는 healthy인데 모든 채팅이 500 → 파이프라인이 "성공"으로 보고 구버전을 내린다. 크래시루프면 롤아웃이 멈추고 구버전이 계속 서비스한다 |
| DB/Redis 미도달 | **부팅 거부** | 첫 사용자 요청에서 발견하면 그 요청은 이미 실패한 뒤다 |
| `DATABASE_URL` 형식 오류 | **부팅 거부** | 잘못된 설정은 런타임 한가운데가 아니라 배포 단계에서 죽어야 싸다 |
| `image.tag` 미지정 | **Helm이 렌더링 거부** | 암묵적 latest는 롤백을 불가능하게 만든다 |
| 마이그레이션 실패 | **배포 중단**, 앱은 뜨지 않음 | 스키마가 반쯤 적용된 채 새 코드가 뜨는 것이 최악 |
| 백업 시 클라이언트 버전 불일치 | **백업 거부** | 복원 못 하는 백업을 만드는 것보다 낫다 |

### 5.7 스케일링 시점 판단

| 신호 | 조치 |
|---|---|
| `aios_pg_pool_waiting > 0` 지속 | pgbouncer(transaction mode) 도입 |
| API CPU가 지속적으로 70%+ | HPA가 자동 확장(기본 max 10). 상한 조정 |
| 인덱싱이 밀림 | `worker.replicaCount` 증가 |
| 코드 청크 1천만+ | pgvector `ef_search` 튜닝 → 그래도 느리면 프로젝트 샤딩 |
| 도구 실행 지연 | 샌드박스 전용 노드 풀 + 워밍 컨테이너 |

상세는 [07-scaling-cost-bottleneck.md](07-scaling-cost-bottleneck.md).

---

## 6. 배포 전 최종 점검

```
[ ] pnpm verify 통과 (exit 0)
[ ] 프로바이더 키 1개 이상 + (RAG 쓸 거면) 임베딩 가능 프로바이더
[ ] DB에 pgvector 확장 활성화
[ ] 마이그레이션이 앱보다 먼저 도는 구성
[ ] TLS 종단에서 버퍼링 OFF (SSE)
[ ] /readyz 가 LB/probe에 연결됨
[ ] 시크릿이 저장소가 아닌 시크릿 관리자에 있음
[ ] 백업 cron 등록 + 복원 1회 실습 완료
[ ] 알람: circuit_open, pool_waiting, success_rate
[ ] 롤백 절차를 실제로 한 번 실행해 봄
```

---

## 부록: 검증하지 않은 것

정직하게 기재한다.

1. **경로 C(관리형 조합)는 미검증** — 개별 요소는 표준이나 조합 전체는 배포해 보지 않았다.
2. **멀티 노드 클러스터 미검증** — 검증은 단일 노드 kind에서 했다. `podAntiAffinity`는 노드가 하나면 효과가 없다.
3. **실제 Ingress 컨트롤러 미검증** — kind 검증에서는 `ingress.enabled=false`로 Service까지만 확인했다. nginx annotation의 실제 효과(버퍼링 OFF)는 검증되지 않았다.
4. **HPA 실동작 미검증** — metrics-server가 없어 `autoscaling.enabled=false`로 검증했다.
5. **TLS/cert-manager 미검증**.
6. **대규모 부하 하의 배포 미검증** — 무중단 검증은 초당 ~7 요청 수준이었다.

---

## Sprint #3 추가 배포 요구사항

### 마이그레이션

`0002_collab_marketplace_oauth.sql`, `0003_api_key_role.sql`이 추가됐다.
Helm의 pre-install/pre-upgrade Job이 자동 적용하므로 별도 조치는 없다.
테이블 19개 → 26개 (`collab_docs`, `oauth_states`, `oauth_accounts`, `auth_sessions`,
`plugin_ratings`, `plugin_publish_events`, `stripe_events`).

### 새 환경변수

`docs/12-sprint3-completion.md` §8 참조. 전부 선택값이며, 미설정 시 해당 기능만
비활성화되고 서버는 정상 기동한다.

**단, 아래 둘은 값이 없으면 기능이 조용히 막히므로 의도를 확인할 것:**

- `OAUTH_ALLOWED_REDIRECTS` — 미설정이면 모든 redirect가 차단된다(안전한 기본값).
  프론트엔드 오리진을 반드시 넣어야 로그인 후 앱으로 돌아갈 수 있다.
- `MARKETPLACE_REVIEWER_ORG` — 미설정이면 아무도 플러그인을 승인할 수 없다.
  결과적으로 **서명된 번들만** 유통된다. 이것이 의도라면 그대로 두어도 된다.

### 협업 WebSocket 운영 주의

1. **Ingress 타임아웃**: 협업 소켓은 오래 열려 있다. nginx-ingress 기준
   `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` 이상을 권장한다.
   기본 60초면 1분마다 재연결이 발생한다.

2. **셧다운**: `onClose` 훅이 모든 열린 문서를 flush한다. `terminationGracePeriodSeconds`가
   너무 짧으면 최대 2초(디바운스)의 편집이 유실된다. 현재 차트의 25초 데드라인이면 충분하다.

3. **수평 확장**: Redis Pub/Sub이 인스턴스 간 update를 전파하므로 sticky session은
   **필요 없다.** 2개 인스턴스를 실제로 띄워 검증했다 (`s6:collab-multi`, PASS 9/9):
   서로 다른 서버에 붙은 클라이언트끼리 편집·프레즌스가 Redis를 통해 전파되고,
   늦게 접속한 클라이언트도 다른 인스턴스가 만든 문서를 받는다.
   문서별 채널 격리도 확인했다 — 무관한 문서로는 새지 않는다.

4. **문서 크기**: 프레임당 1MB 상한이 걸려 있다. 대형 문서의 초기 sync는
   여러 프레임으로 나뉘어 오므로 문제되지 않는다.

---

## 웹 UI 배포

`infra/Dockerfile`이 UI를 함께 빌드해 이미지의 `/app/web`에 담는다. **추가 설정은 필요 없다** —
API가 부팅하면서 자동으로 마운트하고 로그에 `web UI mounted`를 남긴다.

### 반드시 확인할 것

1. **UI와 API는 같은 오리진이어야 한다.** OAuth 세션이 `HttpOnly` + `SameSite=Lax` 쿠키라
   다른 오리진에 UI를 두면 브라우저가 쿠키를 붙이지 않아 **로그인이 동작하지 않는다.**
   CDN에 별도로 올리고 싶다면 CORS와 `SameSite=None`이 필요한데, 그건 CSRF 방어를 내리는 선택이다.

2. **`OAUTH_ALLOWED_REDIRECTS`에 UI 오리진을 넣어야 한다.** 미설정이면 모든 redirect가
   차단되어 로그인 후 앱으로 돌아오지 못한다.

3. **`PUBLIC_BASE_URL`이 실제 외부 주소와 같아야 한다.** OAuth 콜백 URL이 이 값에서 만들어지므로
   IdP에 등록한 주소와 일치하지 않으면 교환이 실패한다.

### 헤드리스(API만) 운영

이미지에서 `/app/web`을 비우거나, 별도로 빌드한 API 번들만 배포하면 된다.
번들이 없으면 서버는 조용히 건너뛰고 `serving API only`를 로그에 남긴다 — 부팅에 실패하지 않는다.

### 캐시

- `index.html` → `no-cache` (배포가 사용자에게 도달해야 한다)
- `/assets/*` → `immutable`, 1년 (파일명에 해시가 붙어 있다)

CDN을 앞에 둔다면 이 두 정책을 그대로 통과시켜야 한다. CDN이 `index.html`을 캐시하면
새 배포가 반영되지 않는다.

---

## 공공통계 데이터셋 배포

지난 작업으로 만든 2.5억 행 데이터셋은 **Helm 차트가 전혀 모르는 상태**였다.
그대로 배포하면 bigdata 도구가 조용히 등록되지 않고, `/data` 화면은 빈 응답을 받고,
여전히 외부 AI 키를 요구한다. 그것을 채웠다.

### 왜 이미지에 굽지 않는가

DuckDB 파일은 2.5GB 이고 런타임에는 **읽기 전용**이다. 이미지에 넣으면:

- 이미지가 2.5GB 커져 롤아웃마다 모든 노드가 그만큼을 내려받는다
- 데이터가 갱신될 때마다 앱 이미지를 다시 빌드해야 한다 — **코드와 데이터의 수명이 다르다**

그래서 PVC 로 분리했다. 데이터 갱신은 배포와 무관한 별도 Job 이 담당한다.

### 설정

```yaml
bigdata:
  enabled: true
  existingClaim: aios-bigdata-pvc   # ReadOnlyMany — 여러 파드가 함께 붙는다
  mountPath: /data/bigdata
  fileName: bigdata.duckdb

localLlm:
  enabled: true
  baseUrl: http://ollama.ai.svc.cluster.local:11434/v1
  models: "qwen3:8b"                # 실측 최우수 (도구·한국어 모두 100%)
  embedModel: "bge-m3"
  embedDim: 1024                    # bge-m3=1024, OpenAI=1536
```

`bigdata.enabled` 는 기본 `false` 다. 데이터 없는 배포에서 LLM 이 존재하지 않는 도구를
부르며 실패하는 것을 막기 위해서다 — 있으면 등록하고, 없으면 아예 노출하지 않는다.

**설정 실수는 조용히 통과하지 않는다:**

```
$ helm template aios infra/helm --set bigdata.enabled=true
Error: bigdata.enabled 이면 existingClaim 이 필요하다

$ helm template aios infra/helm --set localLlm.enabled=true
Error: localLlm.enabled 이면 baseUrl 이 필요하다
```

볼륨은 `readOnly: true` 로 붙인다. DuckDB 는 **쓰기 연결이 파일 락을 잡아**
파드가 여러 개면 서로 막는다.

### 임베딩 차원

`embedDim` 은 차트가 자동으로 적용하지 못한다 — Postgres 스키마 변경이라
마이그레이션 경로를 거쳐야 한다. 배포 전에 한 번 실행한다:

```bash
EMBED_DIM=1024 node scripts/set-embedding-dim.mjs
```

어긋나면 `expected 1536 dimensions, not 1024` 로 저장이 실패한다.

### 이미지 검증

네이티브 모듈(`@duckdb/node-api`)이 컨테이너에서 실제로 도는지 확인했다:

```
$ docker run --rm aios-api:current sh -c 'ls node_modules/@duckdb/node-bindings-linux-arm64/'
duckdb.node          ← Linux ARM64 바이너리 포함

$ curl -H "Authorization: Bearer …" localhost:8797/v1/bigdata/categories
{"categories":[{"category":"01_인구_사회","series_count":200,"row_count":2663544}]}
```

DuckDB 파일을 마운트해 컨테이너 안에서 질의까지 성공했다.

---

## 데이터셋 백업 — `scripts/backup-bigdata.sh`

`scripts/backup.sh` 는 Postgres 만 다룬다. bigdata 산출물은 다른 곳에 있고
다른 방식으로 만들어지므로 별도 스크립트가 필요하다.

### 무엇을 백업하고 무엇을 하지 않는가

| 대상 | 백업 | 이유 |
|---|---|---|
| Parquet (898MB) | O | 원본 CSV 에서 재생성 가능하지만 45분 걸린다 |
| catalog.parquet | O | `series_id` 가 여기서 정해진다 — 잃으면 팩트와 어긋난다 |
| 임베딩 (22MB) | O | 재생성에 Ollama 가 떠 있어야 한다 — 복구 조건이 까다롭다 |
| DuckDB (2.5GB) | **X** | Parquet 에서 8분이면 재생성된다 |
| 원본 CSV | **X** | 사용자의 원본이고 우리가 만든 것이 아니다 |

결과 922MB. DuckDB 를 빼서 2.5GB 를 아꼈다.

### 복구 검증에서 실제 버그를 잡았다

백업본만으로 별도 경로에 복구해 보니, 데이터는 **완전히 일치**하는데
(252,252,221행, 합계 67716.285조, 임베딩 6,597) 의미 검색이 실패했다:

```
Binder Error: No function matches 'array_cosine_similarity(FLOAT[], FLOAT[1024])'
```

**Parquet 왕복에서 고정 크기 배열 `FLOAT[1024]` 이 가변 `FLOAT[]` 로 풀린다.**
행 수와 합계가 맞으므로 검증하지 않았다면 "복구 성공"으로 믿었을 것이고,
실제 장애 상황에서야 발견했을 것이다.

복구 절차에 차원 캐스팅을 넣어 고쳤다. 차원은 하드코딩하지 않고 데이터에서 읽는다:

```python
dim = con.execute("select len(embedding) from read_parquet('...') limit 1").fetchone()[0]
con.execute(f"create table catalog_embeddings as "
            f"select series_id, embedding::FLOAT[{dim}] as embedding from read_parquet('...')")
```

수정 후 복구본으로 `s4:bigdata` **38/38 PASS**. 백업이 실제로 쓸 수 있음을 확인했다.

백업에는 `RESTORE.md` 를 함께 넣는다 — 백업만 있고 절차가 없으면 급할 때 쓸 수 없다.


---

## 고아 compose 스택 — 개발 DB가 삭제된 디렉터리에 묶여 있었다

`phase8`(Production) 의 복구 왕복 검증이 이렇게 실패했다:

```
FAILED: restore.pgvector_restored — output: service "postgres" is not running
```

그런데 Postgres 는 멀쩡히 돌고 있었다. 애플리케이션도 정상이었다.

원인은 **compose 프로젝트 불일치**였다:

공개 문서의 기록에서는 개인 홈 경로를 `$HOME`로 일반화했다.

```
$ docker inspect 1-postgres-1 --format '{{index .Config.Labels "com.docker.compose.project"}} …'
1 | postgres | $HOME/Desktop/난제1     ← 이 디렉터리는 더 이상 존재하지 않는다

$ docker-compose config --format json | head    # T7 저장소에서
{ "name": "1ai", …                              ← 다른 프로젝트

$ docker-compose ps                             # T7 저장소에서
(비어 있음)
```

프로젝트를 T7 로 옮기기 전, 맥 데스크톱 사본에서 띄운 컨테이너가 그대로 살아 있었다.
포트(5432)가 발행돼 있으니 `DATABASE_URL` 로는 잘 붙는다 — 그래서 몇 주 동안 아무도 몰랐다.
하지만 **compose 를 경유하는 모든 작업**(`exec`, `logs`, `down`, 복구 검증)은
저장소가 보는 빈 프로젝트 `1ai` 를 향한다.

데이터는 `1_pgdata` / `1_redisdata` 볼륨에 있고, 이들도 옛 프로젝트 이름에 묶여 있다.

### 왜 그냥 넘길 문제가 아닌가

- **백업/복구 검증이 불가능하다.** 실제 운영 사고에서 가장 필요한 절차가 미검증 상태다.
- 관리 주체가 없다. `docker-compose down` 이 이 스택을 내리지 못한다.
- 사용자의 제약(T7 폴더만 사용, 맥에는 두지 않는다)과 어긋난 잔재다.

### 이관 절차 (데이터 보존)

볼륨 이름은 프로젝트 접두사가 붙으므로 새 프로젝트는 빈 볼륨을 만든다.
따라서 볼륨 내용을 복사한 뒤 기동해야 한다. 옛 볼륨은 그대로 두므로 언제든 되돌릴 수 있다.

```bash
docker exec -i 1-postgres-1 pg_dump --format=custom --no-owner --no-privileges -U aios -d aios \
  > /Volumes/T7/bigdata/backups/pre-migration.dump          # 안전망 (이미 수행: 87K)

docker stop 1-postgres-1 1-redis-1
docker volume create 1ai_pgdata
docker run --rm -v 1_pgdata:/from -v 1ai_pgdata:/to alpine sh -c 'cd /from && cp -a . /to/'
docker volume create 1ai_redisdata                          # redis 는 캐시라 비워도 된다
docker-compose up -d postgres redis                         # T7 저장소에서 → 프로젝트 1ai
```

기동 후 대조할 기준값 (이관 직전 실측):

```
tables=26  plans=3  orgs=27  memory=2  migrations=3
```

되돌리려면 `docker-compose down` 후 `docker start 1-postgres-1 1-redis-1` 이면 된다 —
옛 볼륨 `1_pgdata` 는 건드리지 않는다.


---

## Postgres 복구 검증 — `scripts/verify-restore.sh`

고아 compose 스택 때문에 phase8 의 복구 왕복 검증을 돌릴 수 없었다. 그런데
**백업/복구는 실제 장애에서 가장 필요한 절차다.** 배포 배선이 어긋났다는 이유로
미검증 상태를 방치할 수는 없어, 컨테이너를 직접 지목하는 스크립트로 분리했다.

```bash
scripts/verify-restore.sh              # 기본 컨테이너: 1-postgres-1
scripts/verify-restore.sh my-postgres  # 다른 컨테이너
```

### 행 수를 세는 것으로는 부족하다

DuckDB 백업에서 이미 겪었다 — 행 수·합계가 **전부 일치**하는데
`array_cosine_similarity` 가 실패했다(고정 크기 배열 `FLOAT[1024]` 가 가변 `FLOAT[]` 로 풀렸다).
"복구 성공"으로 믿고 넘겼다면 실제 장애 때 발견했을 것이다.

그래서 이 스크립트는 구조와 **기능**을 나눠 본다:

```
  테이블      26
  pgvector    vector
  벡터 차원   1024        ← pg_dump 는 타입 수식자를 보존한다 (Parquet 왕복과 다른 점)
  벡터 인덱스 1
  외래키      33
  기억 행수   1002
  유사도 질의 5 행        ← 여기까지 와야 '쓸 수 있는 백업'이다
=== PASS — 복구본이 실제로 사용 가능하다 ===
```

**결함 주입으로 검증했다.** 복구본의 `memory_items` 를 비우면 구조 검사 6개는 전부
그대로 통과하는데(테이블 26, pgvector, 차원 1024, 인덱스 1, 외래키 33) 유사도 질의가
0행이 되어 종료코드 1로 실패한다. 행 수 검사만으로는 잡히지 않는 부류다.

### 실측 결과 (2026-08-28)

운영 중인 개발 DB 기준으로 왕복이 **통과**했다. 복구본이 원본과 완전히 일치하고
벡터 질의까지 동작한다. 즉 **백업은 실제로 쓸 수 있다** — compose 배선 문제와 무관하게.

### phase8 은 이제 원인을 짚어 준다

이전에는 이렇게 실패했다:

```
FAILED: restore.pgvector_restored — output: service "postgres" is not running
```

DB 가 죽은 것처럼 읽히지만 실제로는 멀쩡히 돌고 있었다. 사전 점검을 넣어 실제 소유자를
찾아 알려 준다:

```
FAIL  stack.owned_by_this_repo — 이 저장소의 compose 프로젝트에는 실행 중인 postgres 가 없다.
      실제 소유자: 1-postgres-1 (project=1, dir=$HOME/Desktop/난제1)
      — docs/11-deployment.md "고아 compose 스택" 의 이관 절차를 보라.
      백업/복구 자체는 scripts/verify-restore.sh 로 배포 배선과 무관하게 확인할 수 있다.
```


---

## 배포 준비 검증이 3주 묵은 이미지를 검증하고 있었다

compose 스택을 이관하고 나니 phase8 이 41/45 까지 올라왔고, 남은 4건은 전부
컨테이너가 뜨지 못하는 문제였다. 컨테이너를 직접 띄워 로그를 보니:

```
AiosError: no LLM provider key found. Set at least one of
ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or XAI_API_KEY.
```

현재 소스의 같은 메시지에는 `LOCAL_LLM_BASE_URL` 이 들어 있다. 즉 **옛 코드였다.**

```
$ docker images | grep aios-api
aios-api:current   11 hours ago
aios-api:test      3 weeks ago     ← phase8 이 검증하던 이미지
```

phase8 은 `aios-api:test` 태그가 이미 있다고 가정하고 그냥 썼다. 아무도 굽지 않으므로
**굴러다니는 이미지**를 검증한 것이다. 결과는 "우아한 종료 실패 / 롤백 불가"로 기록됐는데,
원인과 아무 상관이 없다.

**배포 준비 검증이 배포될 코드가 아닌 것을 검증하면 존재 이유가 없다.**

고침 — 태그를 실행마다 고유하게(`aios-api:phase8-<pid>`) 만들어 재사용을 불가능하게 하고,
현재 소스에서 반드시 새로 굽는다. 굽는 것만으로는 부족해서 **뜨는지도 먼저 확인**한다:

```
PASS  image.built_from_current_source — 현재 소스에서 빌드했다 (생성 1.9분 전)
PASS  image.boots_with_configured_providers — 빌드한 이미지가 현재 환경 설정으로 /readyz 를 응답한다
```

이 두 단언이 없으면 아래 단계들이 전부 엉뚱한 이유로 실패하고, 진단이 원인을 가린다.
검증이 남긴 이미지는 `finally` 에서 지운다 — 검증의 쓰레기를 사용자가 치우게 하면 안 된다.

### 배선이 두 벌이면 반드시 갈라진다

같은 `docker run` 환경변수 블록이 8.9(종료)와 8.10(롤백) 두 곳에 복붙돼 있었다.
로컬 프로바이더를 넘기도록 고칠 때 **한 곳만 고쳐졌고**, 다른 하나는 계속
`no_providers_configured` 로 죽으면서 "우아한 종료 실패"로 기록됐다.
`containerEnv()` 하나로 합쳤다.

### 롤백 검증이 증명하는 것과 증명하지 않는 것

`rollback-prev` 는 현재 이미지에 태그만 다시 붙인 것이다. 따라서
`current_version_healthy` / `previous_version_healthy_on_current_schema` 가 증명하는 것은
**교체 기동 절차가 동작한다**까지이고, **버전 간 호환성은 증명하지 않는다.**
그것을 재려면 이전 릴리스 커밋에서 구운 이미지가 필요하다.

버전 호환성 쪽은 대신 스키마를 정적으로 검사한다 —
`migrations_are_additive`(DROP/타입변경 없음)와 `migrations_idempotent` 가
"구버전 앱이 새 스키마를 읽을 수 있는가"를 이미지 없이 본다.
실행 검증과 정적 검증이 서로 다른 것을 덮는다. 코드 주석에도 같은 한계를 적어 뒀다.

### 이관 후 결과

```
PHASE 8 — Deployment readiness: PASS (50/50)
  PASS  stack.owned_by_this_repo — 이 저장소의 compose 프로젝트가 postgres 를 띄우고 있다
  PASS  backup.runs / verifies_restorability / artifact_nonempty
  PASS  restore.schema_restored / pgvector_restored / data_restored
  PASS  deploy.graceful_sigterm — 384ms 만에 배수 후 종료 (유예 25초)
  PASS  rollback.serves_traffic_after_rollback — 인증 강제 확인 (HTTP 401)
```

이관 후 데이터 대조 (기준값과 완전 일치):

```
project=1ai  dir=/Volumes/T7/클로드 코드 T7/클로드 대형 프로젝트/난제1(AI운영체제)
tables=26 plans=3 orgs=41 users=27 memory=1002 sessions=35 migrations=3 vector_dim=1024
```
