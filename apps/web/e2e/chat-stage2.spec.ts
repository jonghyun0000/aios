import { test, expect, type Page } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

async function history(page: Page) {
  const toggle = page.getByRole("button", { name: "대화 내역" });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  return page.getByRole("region", { name: "대화 목록" });
}
test("대화 본문 검색·이름 변경·휴지통·새로고침 후 복구", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  const marker = `찾을본문-${Date.now()}`;
  // 모델을 기다리지 않는 정확 계산으로 본문이 DB에 실제 저장되게 한다.
  await page.getByLabel("메시지 입력").fill("17*23+41"); await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.locator(".messages")).toContainText("432"); await expect(page.getByLabel("메시지 입력")).toBeEnabled();
  const url = page.url();
  const list = await history(page);
  await list.getByRole("button", { name: "17*23+41 대화 관리", exact: true }).first().click();
  await page.getByLabel("대화 이름").fill(marker); await page.getByRole("button", { name: "이름 저장" }).click();
  await list.getByLabel("대화 검색").fill(marker);
  await expect(list.getByRole("link", { name: marker, exact: true })).toHaveCount(1);
  await list.getByRole("button", { name: `${marker} 대화 관리`, exact: true }).click();
  await page.getByRole("button", { name: "대화 삭제…" }).click();
  await page.getByRole("button", { name: "휴지통으로 이동", exact: true }).click();
  await expect(list.getByRole("link", { name: marker, exact: true })).toHaveCount(0);
  await list.getByRole("button", { name: "휴지통", exact: true }).click();
  await expect(list.getByRole("button", { name: marker, exact: true })).toBeVisible();
  await list.getByRole("button", { name: marker, exact: true }).click(); await page.getByRole("button", { name: "대화 복구" }).click();
  await expect(page).toHaveURL(url); await page.reload(); await expect(page.locator(".messages")).toContainText("432");
  const restored = await history(page); await restored.getByLabel("대화 검색").fill("17*23+41");
  await expect(restored.getByRole("link", { name: marker, exact: true })).toBeVisible();
  await restored.getByLabel("대화 검색").fill(`없는-${marker}`); await expect(restored).toContainText("검색 결과가 없습니다.");
});

test("자료 연결로 시작·프로젝트 공유·새로고침·해제", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  await page.getByRole("button", { name: "자료·프로젝트", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "자료·프로젝트" });
  const project = `작업공간-${Date.now()}`;
  await dialog.getByLabel("새 프로젝트 이름").fill(project); await dialog.getByRole("button", { name: "프로젝트 만들기" }).click();
  await expect(dialog).toContainText("새 프로젝트를 만들고 연결했습니다.");
  await dialog.getByLabel("파일 적용 범위").selectOption("project");
  await dialog.getByLabel("참고 파일 선택").setInputFiles({ name: "계획.md", mimeType: "text/markdown", buffer: Buffer.from("배포 암호명: 오로라-731") });
  await expect(dialog.locator(".reference-list")).toContainText("계획.md");
  await expect(dialog.locator(".reference-list")).toContainText("프로젝트 공용");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("button", { name: "자료·프로젝트", exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "+ 새 대화", exact: true }).click();
  await page.getByRole("button", { name: "자료·프로젝트", exact: true }).click();
  await dialog.getByLabel("연결 프로젝트").selectOption({ label: project });
  await expect(dialog.locator(".reference-list")).toContainText("계획.md");
  await dialog.getByLabel("계획.md 연결 해제").click(); await dialog.getByRole("button", { name: "연결 해제 확인" }).click();
  await expect(dialog.locator(".reference-list li")).toHaveCount(0);
  await expect(dialog).toContainText("연결을 해제했습니다.");
  const bounds = await dialog.evaluate((el) => ({ width: el.getBoundingClientRect().width, viewport: innerWidth, overflow: el.scrollWidth - el.clientWidth }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport); expect(bounds.overflow).toBeLessThanOrEqual(1);
});

test("결함 주입: 이름 저장·파일 저장 실패를 표시하고 입력과 기존 자료를 보존한다", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  await page.getByRole("button", { name: "자료·프로젝트", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "자료·프로젝트" });
  await expect(dialog.getByLabel("참고 파일 선택")).toBeEnabled();
  await dialog.getByLabel("참고 파일 선택").setInputFiles({ name: "existing.txt", mimeType: "text/plain", buffer: Buffer.from("기존 자료") });
  await expect(dialog.locator(".reference-list")).toContainText("existing.txt");
  await page.route("**/v1/sessions/*/files", (route) => route.fulfill({ status: 503, json: { error: { message: "고의 파일 저장 실패" } } }));
  await dialog.getByLabel("참고 파일 선택").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("retain") });
  await expect(dialog.getByRole("alert")).toContainText("고의 파일 저장 실패"); await expect(dialog.locator(".reference-list li")).toHaveCount(1);
  await expect(dialog.locator(".reference-list")).toContainText("existing.txt");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  const list = await history(page); await list.getByRole("button", { name: "새 대화 대화 관리", exact: true }).first().click();
  await page.route("**/v1/sessions/*", (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: { message: "고의 이름 저장 실패" } } }) : route.continue());
  await page.getByLabel("대화 이름").fill("잃으면 안 되는 제목"); await page.getByRole("button", { name: "이름 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("고의 이름 저장 실패"); await expect(page.getByLabel("대화 이름")).toHaveValue("잃으면 안 되는 제목");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
});
