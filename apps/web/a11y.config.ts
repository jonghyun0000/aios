import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

/** 모든 API/WS는 각 시험에서 가로챈다. 실제 API·DB·모델을 띄우지 않는 UI 계약 회귀다. */
export default defineConfig(base, {
  testMatch: "a11y-workflows.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4175" },
  webServer: {
    command: `"${process.execPath}" "${fileURLToPath(new URL("./node_modules/vite/bin/vite.js", import.meta.url))}" preview --host 127.0.0.1 --port 4175 --strictPort`,
    url: "http://127.0.0.1:4175",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
