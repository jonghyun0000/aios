import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/**
 * 모바일 레이아웃.
 * playwright.config.ts 의 mobile 프로젝트(iPhone 13)에서만 의미가 있다.
 */
test.describe("반응형", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("좁은 화면에서 사이드바가 본문을 밀어내지 않는다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "모바일 프로젝트 전용");
    await goRoute(page, "/data");

    const { navW, mainW, viewport } = await page.evaluate(() => ({
      navW: document.querySelector("nav")?.getBoundingClientRect().width ?? 0,
      mainW: document.querySelector("main")?.getBoundingClientRect().width ?? 0,
      viewport: window.innerWidth,
    }));
    // 한때 사이드바가 232px 고정이라 375px 화면의 62%를 먹고 본문이 143px로 눌렸다.
    expect(mainW / viewport, "본문이 화면 대부분을 차지해야 한다").toBeGreaterThan(0.9);
    expect(navW, "내비가 본문 옆에 남아 있으면 안 된다").toBeGreaterThan(viewport * 0.9);
  });

  test("본문이 가로로 넘치지 않는다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "모바일 프로젝트 전용");
    await goRoute(page, "/data");
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "가로 스크롤이 생겼다").toBeLessThanOrEqual(1);
  });

  test("표는 잘리지 않고 가로 스크롤된다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "모바일 프로젝트 전용");
    await goRoute(page, "/data");
    const style = await page.evaluate(() => {
      const t = document.querySelector("table");
      return t ? getComputedStyle(t).overflowX : "";
    });
    // 열을 숨기면 사용자가 데이터가 있는지조차 모른다.
    expect(style).toBe("auto");
  });
});
