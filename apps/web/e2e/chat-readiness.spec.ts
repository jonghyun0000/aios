import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

test.beforeEach(async ({ page }) => { await login(page); await goRoute(page, "/chat"); });

test("새 대화 생성 실패가 보이고 입력을 잃지 않는다", async ({ page }) => {
  await page.route("**/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "테스트용 저장 실패" } } });
  });
  await page.getByRole("textbox", { name: "메시지 입력" }).fill("보존할 메시지");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("테스트용 저장 실패");
  await expect(page.getByRole("textbox", { name: "메시지 입력" })).toHaveValue("보존할 메시지");
  await expect(page.getByRole("button", { name: "전송", exact: true })).toBeEnabled();
});

test("HTTP 응답 실패를 완료로 안내하지 않는다", async ({ page }) => {
  await page.route("**/v1/sessions/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "테스트용 모델 연결 실패" } } });
  });
  await page.getByRole("textbox", { name: "메시지 입력" }).fill("연결 오류 검사");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("테스트용 모델 연결 실패");
  await expect(page.getByRole("status").filter({ hasText: "응답이 실패했습니다." })).toBeAttached();
  await expect(page.getByText("응답이 완료되었습니다.", { exact: true })).toHaveCount(0);
});

test("느린 세션 생성 중 단축키를 반복해도 하나만 생성한다", async ({ page }) => {
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    await gate;
    await route.fulfill({ status: 503, json: { error: { message: "고의 생성 실패" } } });
  });
  const input = page.getByRole("textbox", { name: "메시지 입력" });
  await input.fill("중복 방지 검사");
  await input.press("Control+Enter");
  await expect.poll(() => creates).toBe(1);
  await page.keyboard.press("Control+Enter");
  await expect(input).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("고의 생성 실패");
  expect(creates).toBe(1);
});
