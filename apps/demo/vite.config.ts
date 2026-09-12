import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 본 앱의 API 프록시/환경 설정을 재사용하지 않는다. 배포물은 자체 정적 파일뿐이다.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
});
