import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

test("실제 자동 계산·계측·저장·새로고침", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  await expect(page.getByRole("combobox", { name: "응답 모드" })).toHaveValue("auto");
  const input = page.getByLabel("메시지 입력");
  await input.fill("What is 17 * 23 + 41? Reply with only the number.");
  await input.press("Enter");
  await expect(page.locator(".messages")).toContainText("432");
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("chat-strategy")).toContainText("정확 계산");
  await page.getByTestId("chat-timings").locator("summary").click();
  await expect(page.getByTestId("chat-timings")).toContainText("첫 글자까지");
  await expect(page.getByTestId("chat-timings")).toContainText("답변 저장");
  await page.reload();
  await expect(page.locator(".messages")).toContainText("432");
  await expect(page.locator(".msg")).toHaveCount(2);
});

test("계측 상세를 열어도 모바일 입력창과 가로 레이아웃이 유지된다", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  await page.getByLabel("메시지 입력").fill("0.1 + 0.2");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByLabel("메시지 입력")).toBeEnabled();
  await expect(page.locator(".messages")).toContainText("0.3");
  await page.getByTestId("chat-timings").locator("summary").click();
  const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, bottom: document.querySelector(".composer")!.getBoundingClientRect().bottom, height: innerHeight }));
  expect(bounds.overflow).toBeLessThanOrEqual(1); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
});
