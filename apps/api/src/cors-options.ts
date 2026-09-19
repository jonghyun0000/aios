import type { FastifyCorsOptions } from "@fastify/cors";

/**
 * CORS 옵션. methods 를 명시하는 이유:
 *  @fastify/cors 는 v10 부터 기본 methods 를 `GET,HEAD,POST` 로 좁혔다 (v9 는 PUT/PATCH/DELETE 포함).
 *  우리는 origin:true 로 다른 오리진(개발용 Vite 서버 등)을 받으므로, 명시하지 않으면
 *  버전을 올리는 것만으로 PUT/PATCH/DELETE 의 프리플라이트가 조용히 실패한다.
 *  타입 검사도 단위 테스트도 이걸 못 잡는다 — 브라우저 밖에서는 프리플라이트가 없기 때문이다.
 */
export const CORS_OPTIONS: FastifyCorsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
};
