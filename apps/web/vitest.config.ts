import { defineConfig } from "vitest/config";
import { sharedTestConfig } from "../../vitest.shared.js";

/**
 * vitest 와 Playwright 의 영역을 나눈다.
 *
 * e2e/ 를 배제하지 않으면 vitest 가 *.spec.ts 를 테스트로 수집해
 * `test is not defined` 로 실패한다 — 두 러너의 전역 API가 다르기 때문이다.
 * E2E 는 `pnpm --filter @aios/web test:e2e` 로 따로 돌린다.
 */
export default defineConfig({
  test: {
    ...sharedTestConfig,
    exclude: [...(sharedTestConfig?.exclude ?? []), "**/e2e/**"],
  },
});
