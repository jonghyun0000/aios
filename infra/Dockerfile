# Multi-stage: 하나의 이미지 정의에서 api / worker 두 타깃을 뽑는다.
# 이유: 두 프로세스는 같은 코드베이스의 다른 엔트리포인트일 뿐이므로 빌드 캐시를 공유하는 편이
# 이미지 드리프트(api와 worker가 서로 다른 코드로 배포되는 사고)를 막는다.
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# --- deps: 매니페스트만 먼저 복사해 레이어 캐시를 살린다 ---
# 소스가 바뀌어도 의존성이 그대로면 install 레이어를 재사용한다.
FROM base AS deps
# .npmrc 를 함께 넣는다 — engine-strict 가 여기 있어야 **이미지 빌드 단계에서** 막힌다.
# 없으면 Node 20 이미지에 Node 22 전용 패키지가 그대로 설치되고, 컨테이너가 부팅할 때에야
# 죽는다. 실제로 그렇게 겪었다: 호스트(Node 22)에서는 멀쩡하고 이미지만 크래시했다.
COPY .npmrc* ./
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY apps/cli/package.json ./apps/cli/
COPY apps/verify/package.json ./apps/verify/
COPY packages/ai/package.json ./packages/ai/
COPY packages/collab/package.json ./packages/collab/
COPY apps/web/package.json ./apps/web/
COPY packages/indexer/package.json ./packages/indexer/
COPY packages/memory/package.json ./packages/memory/
COPY packages/plugin-host/package.json ./packages/plugin-host/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/shared/package.json ./packages/shared/
COPY packages/tools/package.json ./packages/tools/
COPY extensions/vscode/package.json ./extensions/vscode/
RUN pnpm install --frozen-lockfile

# --- build: 소스를 넣고 api 번들 + 자립형 런타임 트리를 만든다 ---
FROM deps AS build
COPY tsconfig.base.json turbo.json ./
# vitest.shared.ts 는 각 패키지의 vitest.config.ts 가 import 하고,
# 그 config 는 tsconfig include 에 들어 있어 `tsc --noEmit` 대상이다.
# 빠뜨리면 빌드가 TS2307 로 실패한다 — 이미지 빌드가 로컬 빌드와 달라지면 안 된다.
COPY vitest.shared.ts ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN pnpm --filter @aios/api build
# 웹 UI를 같은 이미지에 담는다. API가 같은 오리진에서 서빙해야
# HttpOnly + SameSite=Lax 세션 쿠키가 동작한다(별도 오리진이면 쿠키가 붙지 않는다).
RUN pnpm --filter @aios/web build

# pnpm의 node_modules는 .pnpm 저장소를 가리키는 심볼릭 링크 farm이다.
# 이 디렉토리를 COPY로 옮기면 상대 심볼릭 링크가 전부 깨져 런타임에
# ERR_MODULE_NOT_FOUND가 난다(실제로 겪은 실패). `pnpm deploy`는 링크를 실체화한
# 자립형 트리를 만들어 주므로 COPY 후에도 동작한다.
# node-linker=hoisted: 결과 트리를 npm 스타일 평면 구조로 만들어 이식성을 높인다.
RUN pnpm --filter @aios/api --prod --config.node-linker=hoisted deploy /app/deploy

# --- runtime 공통: 번들 + 자립형 프로덕션 의존성만 ---
# 번들이 워크스페이스 코드를 흡수했으므로 런타임에 우리 소스는 필요 없다.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/deploy/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
# static.ts가 /app/web 을 후보 경로로 찾는다.
COPY --from=build /app/apps/web/dist ./web
# 파일 모드를 이미지 안에서 확정한다.
# 이것이 없으면 호스트의 파일 권한이 그대로 복사된다. 저장소가 exFAT/SMB 볼륨에 있으면
# 소스가 0700(소유자 전용)으로 나타나고, 컨테이너는 USER node(uid 1000)로 실행되므로
# 자기 코드를 읽지 못해 `EACCES: permission denied, open '/app/dist/main.js'` 로 즉사한다.
# 빌드 머신의 파일시스템에 따라 이미지가 되기도 안 되기도 하면 재현 가능한 빌드가 아니다.
# COPY --chmod 대신 RUN chmod를 쓰는 이유: --chmod는 BuildKit 전용이라
# 레거시 빌더에서 빌드가 아예 실패한다.
RUN chmod -R a+rX /app/dist /app/web /app/node_modules
# 번들은 ESM이다. package.json이 없으면 Node가 .js를 CJS로 읽어 즉시 문법 에러가 난다.
RUN printf '{"type":"module"}' > package.json && chmod 644 package.json
# 비루트 실행: node 이미지가 제공하는 uid 1000 사용
USER node

# --- migrate: 원샷 마이그레이션 러너 ---
# 앱 이미지와 분리하는 이유: 앱 인스턴스가 여러 개일 때 각자 마이그레이션을 돌리면
# 경합이 나고, 롤백 시 스키마/코드 버전이 어긋난다. 배포 파이프라인이 이걸 먼저 돌린다.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=build /app/deploy/node_modules ./node_modules
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY infra/migrations ./infra/migrations
# runtime 스테이지와 같은 이유 — 호스트 파일 모드가 새어 들어오면 비루트 실행이 깨진다.
RUN chmod -R a+rX /app/scripts /app/infra /app/node_modules
RUN printf '{"type":"module"}' > package.json && chmod 644 package.json
USER node
CMD ["node", "scripts/migrate.mjs"]

FROM runtime AS api
EXPOSE 8787
# tini 없이도 안전하도록 --enable-source-maps 와 함께 직접 실행.
# 프로세스가 PID 1이 되므로 SIGTERM을 직접 받는다 (main.ts가 처리).
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS worker
CMD ["node", "--enable-source-maps", "dist/worker.js"]
