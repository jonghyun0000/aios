import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * 웹 UI(SPA) 서빙.
 *
 * 왜 API와 같은 프로세스에서 서빙하는가:
 *  로그인 세션이 HttpOnly + SameSite=Lax 쿠키다. UI와 API가 다른 오리진이면
 *  브라우저가 이 쿠키를 API 요청에 붙이지 않아 로그인이 동작하지 않는다.
 *  CORS를 열고 SameSite=None으로 바꾸면 되지만, 그건 CSRF 방어를 스스로 내리는 것이다.
 *  정적 파일 서빙 비용(파일 몇 개)보다 그 대가가 훨씬 크다.
 *
 * 번들이 없으면 조용히 건너뛴다. API만 배포하는 구성(헤드리스)이 정상적으로 존재하며,
 * 그 경우 서버가 부팅에 실패하면 안 된다.
 */
export async function registerWebUi(app: FastifyInstance): Promise<boolean> {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev(tsx, apps/api/src) 와 prod(번들, /app/dist) 두 경우의 상대 위치가 다르다.
  const candidates = [
    process.env.AIOS_WEB_DIST,
    resolve(here, "../../web/dist"),   // 개발: apps/api/src → apps/web/dist
    resolve(here, "../web"),           // 컨테이너: /app/dist → /app/web
    resolve(here, "./web"),
  ].filter((p): p is string => Boolean(p));

  const root = candidates.find((p) => existsSync(join(p, "index.html")));
  if (!root) {
    app.log.info("web UI bundle not found — serving API only");
    return false;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    // 해시가 붙은 자산은 내용이 바뀌면 이름이 바뀐다 → 영구 캐시가 안전하다.
    // index.html은 절대 캐시하지 않는다. 캐시되면 새 배포가 사용자에게 도달하지 않는다.
    // @fastify/static v8+ 는 raw ServerResponse 가 아니라 FastifyReply 를 넘긴다(res.setHeader 없음).
    setHeaders(res, path) {
      if (path.endsWith("index.html")) res.header("cache-control", "no-cache");
      else if (path.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
    },
  });

  // SPA fallback. 해시 라우팅이라 실제로는 잘 쓰이지 않지만,
  // 사용자가 /billing 같은 주소를 직접 치는 경우를 404로 만들지 않는다.
  app.setNotFoundHandler((req, reply) => {
    // API 경로의 404는 그대로 404여야 한다. HTML을 돌려주면 클라이언트가
    // JSON 파싱에 실패해 "잘못된 응답"이라는 엉뚱한 에러를 보게 된다.
    if (req.raw.url?.startsWith("/v1/") || req.raw.url?.startsWith("/healthz")) {
      return reply.status(404).send({ error: { code: "not_found", message: "route not found", retryable: false } });
    }
    return reply.sendFile("index.html");
  });

  app.log.info({ root }, "web UI mounted");
  return true;
}
