import type { Page } from "@playwright/test";

/**
 * API 키로 로그인한다.
 *
 * 왜 매 테스트마다 하는가: storageState 로 세션을 재사용하면 빠르지만,
 * 로그인 자체가 회귀하면 **모든 테스트가 통과하면서 로그인만 깨져 있는** 상태가 된다.
 * 로그인은 이 앱에서 가장 자주 건드리는 경로 중 하나라 매번 통과시키는 편이 낫다.
 */
export async function login(page: Page): Promise<void> {
  await page.goto("/");
  // 이미 로그인돼 있으면(localStorage 유지) 로그인 폼이 없다.
  const pw = page.locator('input[type=password]');
  const nav = page.getByRole("navigation");
  await pw.or(nav).first().waitFor({ state: "visible" });
  if (await nav.isVisible()) return;
  const key = process.env.AIOS_API_KEY;
  if (!key) throw new Error("AIOS_API_KEY 환경변수가 필요하다");

  await page.getByLabel("이 브라우저에서 로그인 유지").check();
  await pw.fill(key);
  await page.getByRole("button", { name: "API 키로 로그인" }).click();
  // 사이드바가 나타나야 로그인 완료다.
  await page.getByRole("navigation").waitFor({ state: "visible" });
}

/**
 * 해시 라우팅이므로 goto 후 렌더를 기다린다.
 *
 * networkidle 만으로는 부족하다 — 요청이 끝나도 React 가 아직 그리지 않았을 수 있다.
 * h1 이 나타나는 것이 '이 화면이 그려졌다'는 실제 신호다.
 * (고정 sleep 을 쓰면 느린 기기에서 깨지고 빠른 기기에서 시간을 낭비한다.)
 */
export async function goRoute(page: Page, route: string): Promise<void> {
  await page.goto(`/#${route}`);
  await page.waitForLoadState("networkidle");
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 20_000 });
}
