import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/**
 * 실제로 발생했던 버그에 대한 회귀 테스트.
 *
 * 여기 있는 것은 전부 **한 번 깨졌던 것**이다. 일반적인 UI 검사보다 우선순위가 높다 —
 * 한 번 깨진 곳은 다시 깨진다.
 */
test.describe("회귀 — 차트 라벨 겹침", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("x축 라벨이 서로 겹치지 않는다", async ({ page }) => {
    // 해양관측(10분 간격)은 라벨이 '1999-01-01 00:00' 처럼 16자다.
    // 고정 8개로 뽑던 시절 375px 화면에서 겹쳐서 읽을 수 없었다.
    await goRoute(page, "/data/6577");
    await page.locator("svg path").first().waitFor();

    const overlaps = await page.evaluate(() => {
      const CHAR_W = 5.6; // fontSize 10 기준
      const labels = [...document.querySelectorAll("svg text")]
        .map((el) => ({
          x: Number(el.getAttribute("x")),
          anchor: el.getAttribute("text-anchor"),
          text: el.textContent ?? "",
        }))
        .filter((o) => /[-:]/.test(o.text))
        .sort((a, b) => a.x - b.x);
      // 각 라벨의 좌우 경계를 계산해 실제 겹침 픽셀을 센다.
      const boxes = labels.map((o) => {
        const w = o.text.length * CHAR_W;
        return o.anchor === "start" ? [o.x, o.x + w] : [o.x - w / 2, o.x + w / 2];
      });
      const gaps: number[] = [];
      for (let i = 1; i < boxes.length; i++) {
        const prev = boxes[i - 1];
        const cur = boxes[i];
        if (!prev || !cur) continue;
        const overlap = Math.round(prev[1]! - cur[0]!);
        if (overlap > 0) gaps.push(overlap);
      }
      return gaps;
    });
    expect(overlaps, `라벨이 ${overlaps.join(",")}px 겹친다`).toHaveLength(0);
  });
});

test.describe("회귀 — 접근성", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("모든 폼 필드에 접근 가능한 이름이 있다", async ({ page }) => {
    // 한때 9개 필드가 placeholder 만 있고 라벨이 없었다.
    // placeholder 는 입력을 시작하면 사라지므로 라벨을 대신하지 못한다.
    for (const route of ["/data", "/data/1978", "/chat", "/marketplace"]) {
      await goRoute(page, route);
      const unlabeled = await page.evaluate(() =>
        [...document.querySelectorAll("input,select,textarea")]
          .filter((f) => {
            const el = f as HTMLInputElement;
            return !(el.labels && el.labels.length) && !el.getAttribute("aria-label");
          })
          .map((f) => `${f.tagName}[${(f as HTMLInputElement).type ?? ""}]`),
      );
      expect(unlabeled, `${route}: 라벨 없는 필드`).toHaveLength(0);
    }
  });

  test("키보드 Tab 의 첫 대상이 본문 바로가기다", async ({ page }) => {
    await goRoute(page, "/data");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.className ?? "");
    expect(focused).toContain("skip-link");
  });

  test("Tab 으로 이동하면 포커스 표시가 보인다", async ({ page }) => {
    // :focus 가 아니라 :focus-visible 을 쓰므로 element.focus() 로는 확인되지 않는다.
    // 반드시 실제 키 입력이어야 한다.
    await goRoute(page, "/data");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? getComputedStyle(el).outlineStyle : "none";
    });
    expect(outline, "포커스 표시가 없다 — 키보드 사용자가 위치를 알 수 없다").not.toBe("none");
  });

  test("차트에 스크린리더용 요약이 있다", async ({ page }) => {
    await goRoute(page, "/data/1978");
    const svg = page.locator("svg[role=img]").first();
    await expect(svg).toHaveAttribute("aria-label", /시계열 선 그래프.*시점.*최저.*최고/);
  });

  test("현재 페이지가 aria-current 로 표시된다", async ({ page }) => {
    await goRoute(page, "/data");
    await expect(page.locator("[aria-current=page]")).toHaveCount(1);
    await expect(page.locator("[aria-current=page]")).toContainText("공공통계");
  });
});

test.describe("회귀 — 잘림 고지", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("시점이 잘리면 경고를 띄운다", async ({ page }) => {
    // 10분 간격 데이터에서 기본 limit 400을 넘으면 앞부분만 그려진다.
    // 조용히 자르면 차트가 '전체 기간'인 척한다.
    await goRoute(page, "/data/6577");
    await expect(page.getByText(/앞 [\d,]+개 시점만 표시했습니다/)).toBeVisible();
  });
});
