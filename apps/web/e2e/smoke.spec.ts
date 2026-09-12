import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/**
 * 기본 화면이 뜨는가.
 *
 * "뜬다"의 기준을 스크린샷이 아니라 **의미 있는 내용**으로 잡는다.
 * 빈 껍데기도 스크린샷은 찍히기 때문이다.
 */
test.describe("스모크", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("로그인 후 대시보드에 조직 정보가 보인다", async ({ page }) => {
    await goRoute(page, "/");
    await expect(page.getByRole("heading", { name: "대시보드" })).toBeVisible();
    // 모델 목록이 실제로 채워져야 한다 — API가 죽으면 여기서 잡힌다.
    await expect(page.getByText(/모델 \(\d+개 사용 가능\)/)).toBeVisible();
  });

  test("모든 주요 화면이 오류 없이 렌더된다", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // ErrorBoundary 가 잡은 경우도 실패로 본다 — 화면은 떠 있지만 내용이 없다.
    for (const [route, heading] of [
      ["/", "대시보드"],
      ["/chat", "채팅"],
      ["/data", "공공통계"],
      ["/collab", "실시간 협업"],
      ["/marketplace", "마켓플레이스"],
      ["/billing", "결제"],
      ["/settings", "설정"],
    ] as const) {
      await goRoute(page, route);
      await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByText("이 화면을 표시할 수 없습니다")).toHaveCount(0);
    }
    expect(errors, `콘솔 에러: ${errors.join(" | ")}`).toHaveLength(0);
  });

  test("없는 경로는 404를 보여준다", async ({ page }) => {
    await goRoute(page, "/이런경로없음");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
