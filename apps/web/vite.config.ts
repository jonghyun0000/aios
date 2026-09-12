import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 개발 서버는 API로 프록시한다.
 *
 * 왜 프록시인가 (CORS 허용이 아니라):
 * 로그인 세션이 HttpOnly + SameSite=Lax 쿠키다. 교차 오리진이면 브라우저가
 * 이 쿠키를 붙이지 않아 개발 중에는 로그인이 동작하지 않는다. 프로덕션에서는
 * API가 정적 파일을 같은 오리진에서 서빙하므로, 프록시가 그 구조를 개발에서도 재현한다.
 * "개발에서만 되는 인증"을 만들지 않는 것이 목적이다.
 */
const API_TARGET = process.env.AIOS_API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: true, ws: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
