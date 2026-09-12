import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

test.describe("공공통계 브라우저", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("검색이 결과를 좁힌다", async ({ page }) => {
    await goRoute(page, "/data");
    const before = await page.getByText(/개 중 \d+–\d+/).textContent();

    await page.getByLabel("통계표 이름 검색").fill("전세가격");
    await page.getByRole("button", { name: "검색" }).click();
    await expect(page.getByText(/개 중 \d+–\d+/)).not.toHaveText(before ?? "");

    // 결과가 실제로 키워드를 담아야 한다 — 개수만 보면 엉뚱한 결과도 통과한다.
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toContainText("전세가격");
  });

  test("페이지네이션이 다른 항목을 보여준다", async ({ page }) => {
    await goRoute(page, "/data");
    const first = await page.locator("table tbody tr").first().textContent();
    await page.getByRole("button", { name: "다음" }).click();
    await expect(page.locator("table tbody tr").first()).not.toHaveText(first ?? "");
  });

  test("상세 화면에 차트와 메타데이터가 나온다", async ({ page }) => {
    await goRoute(page, "/data/1978");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("전세가격지수");

    // 차트가 '있다'가 아니라 '그려졌다'를 확인한다. 빈 svg도 존재는 한다.
    const path = page.locator("svg path").first();
    await expect(path).toBeVisible();
    const d = await path.getAttribute("d");
    expect(d, "차트 선이 그려지지 않았다").toBeTruthy();
    expect(d!.length).toBeGreaterThan(50);

    // 카탈로그가 말하는 지역 수와 드롭다운 항목 수가 일치해야 한다.
    // (한때 "지역 1"이라 표시하면서 205개를 고르게 해 사용자를 속였다)
    const meta = await page.getByText(/지역 \d+ · 항목 \d+/).textContent();
    const regionCount = Number(/지역 ([\d,]+)/.exec(meta ?? "")?.[1]?.replace(/,/g, ""));
    const options = await page.getByLabel("지역 필터").locator("option").count();
    expect(options - 1, "카탈로그 region_count 와 드롭다운 항목 수 불일치").toBe(regionCount);
  });

  test("지역 필터가 차트를 바꾼다", async ({ page }) => {
    await goRoute(page, "/data/1978");
    const before = await page.locator("svg path").first().getAttribute("d");
    await page.getByLabel("지역 필터").selectOption({ index: 3 });
    // 필터가 무시되면 화면은 적용했다고 하면서 같은 값을 보여준다 — 조용한 거짓말이다.
    await expect(page.locator("svg path").first()).not.toHaveAttribute("d", before ?? "");
  });
});
