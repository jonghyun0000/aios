import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { AiosError } from "@aios/shared";
import type { AppContext } from "./context.js";
import { authenticate } from "./auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerMarketplaceRoutes } from "./routes/marketplace.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerBigDataRoutes } from "./routes/bigdata.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerWebUi } from "./static.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLocalOperationsRoutes } from "./routes/local-operations.js";
import { registerWs } from "./ws.js";
import { registerCollabWs } from "./collab-ws.js";
import { safeLoggerOptions } from "./safe-logging.js";

export async function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger: safeLoggerOptions(ctx.env.NODE_ENV === "production" ? "info" : "debug"),
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);
  // OAuth 세션 쿠키(HttpOnly)를 읽고 쓰기 위해 필요
  await app.register(cookie);

  // Stripe 웹훅은 서명 검증에 raw body가 필요 — 해당 라우트만 파싱 우회
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  // --- 전역 인증 훅 (공개 경로 제외) ---
  // 헬스/메트릭은 인증 없이 노출한다: LB와 Prometheus는 자격증명을 들고 오지 않는다.
  // 대신 이 경로들은 네트워크 정책(클러스터 내부 전용)으로 보호한다 — 민감 정보는 담지 않는다.
  const PUBLIC = new Set([
    "/healthz", "/readyz", "/metrics",
    "/v1/billing/webhook",           // 서명이 곧 인증
    // 로그인 경로는 인증 없이 들어올 수 있어야 한다 (닭과 달걀).
    "/v1/auth/providers",
    "/v1/auth/:provider/start",
    "/v1/auth/:provider/callback",
    "/v1/auth/session",              // 자체 세션 토큰으로 검증 — 라우트가 직접 처리
    "/v1/auth/logout",
  ]);
  // WebSocket 라우트는 전역 훅에서 제외한다. 브라우저 WS API는 커스텀 헤더를 붙일 수 없어
  // 토큰이 query로 오는데, preHandler 시점에는 아직 그 변환을 하지 않았기 때문이다.
  // 대신 각 WS 핸들러가 업그레이드 직후 authenticate()를 호출하고 실패 시 4401로 닫는다.
  // (이 목록에 라우트 추가를 빠뜨리면 인증이 두 번 걸려 401로 잘린다 —
  //  /v1/collab 추가 시 실제로 발생했다.)
  const WS_ROUTES = new Set(["/v1/ws", "/v1/collab"]);
  app.addHook("preHandler", async (req) => {
    const route = req.routeOptions.url ?? req.url;
    // 인증은 API 표면(/v1/*)에만 건다.
    // 정적 UI(/, /assets/*, index.html)에까지 걸면 로그인 화면 자체를 받을 수 없어
    // 아무도 로그인할 수 없다 — 실제로 UI를 붙이자마자 이 상태가 됐다.
    if (!route.startsWith("/v1/")) return;
    if (PUBLIC.has(route) || WS_ROUTES.has(route)) return;
    req.auth = await authenticate(ctx, req);
  });

  // --- 에러 매핑: 도메인 에러는 구조화된 응답으로, 나머지는 500 + 로그 ---
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AiosError) {
      return reply.status(err.status).send(err.toJSON());
    }
    // zod 검증 실패는 클라이언트 잘못이지 서버 장애가 아니다.
    // 매핑하지 않으면 `?limit=99999` 같은 흔한 실수가 500으로 나가고,
    // 모니터링에서 진짜 장애와 구분되지 않는다.
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: "invalid request parameters",
          retryable: false,
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "internal error", retryable: true } });
  });

  registerHealthRoutes(app, ctx);
  registerLocalOperationsRoutes(app, ctx);
  registerCoreRoutes(app, ctx);
  registerMarketplaceRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerBigDataRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  await registerWs(app, ctx);
  await registerCollabWs(app, ctx);

  // 정적 UI는 마지막에 등록한다 — notFoundHandler가 API 라우트보다 뒤에 와야
  // 이미 등록된 경로를 가리지 않는다.
  await registerWebUi(app);

  return app;
}
