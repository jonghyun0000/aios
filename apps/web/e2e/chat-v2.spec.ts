import { test, expect, type Page } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

type Sent = { content: string; mode: string; routing?: { model: string }; context: { useMemory: boolean } };
async function mockChat(page: Page) {
  const sent: Sent[] = [];
  const messages: { id: string; role: string; content: { text: string } }[] = [];
  const sessions = [{ id: "old", title: "이전 대화 테스트", updated_at: "2026-09-10T12:00:00Z" }];
  await page.route("**/v1/models", (route) => route.fulfill({ json: { models: [
    { model: "qwen3:8b", provider: "local", open: false, successRate: 1, ewmaLatencyMs: 1000 },
    { model: "offline:7b", provider: "local", open: true, successRate: 0, ewmaLatencyMs: 0 },
  ] } }));
  await page.route("**/v1/sessions**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith("/executions")) return route.fulfill({ json: { runs: [] } });
    if (url.pathname.endsWith("/messages")) {
      if (req.method() === "GET") return route.fulfill({ json: { messages } });
      const body = req.postDataJSON() as Sent;
      sent.push(body);
      messages.push({ id: `${sent.length}-user`, role: "user", content: { text: body.content } }, { id: `${sent.length}-ai`, role: "assistant", content: { text: "확인했습니다." } });
      return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"text_delta","text":"확인했습니다."}\n\ndata: {"type":"done","stopReason":"end_turn"}\n\n' });
    }
    if (req.method() === "POST") {
      sessions.unshift({ id: "new", title: req.postDataJSON().title as string, updated_at: "2026-09-12T12:00:00Z" });
      return route.fulfill({ json: { id: "new" } });
    }
    if (url.searchParams.has("cursor")) return route.fulfill({ json: { sessions: [{ id: "older", title: "더 오래된 대화", updated_at: "2026-09-01T12:00:00Z" }], nextCursor: null } });
    return route.fulfill({ json: { sessions, nextCursor: "2026-09-10T12:00:00Z" } });
  });
  await login(page);
  await goRoute(page, "/chat");
  return { sent };
}

test("Enter로 한 번 전송하고 자동 모드와 현재 대화 기억을 유지한다", async ({ page }) => {
  const { sent } = await mockChat(page);
  const input = page.getByRole("textbox", { name: "메시지 입력" });
  await input.fill("엔터 전송 확인");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.locator(".messages")).toContainText("확인했습니다.");
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  expect(sent[0]).toMatchObject({ content: "엔터 전송 확인", mode: "auto", context: { useMemory: true } });
  await page.getByRole("combobox", { name: "응답 모드" }).selectOption("thorough");
  await input.fill("깊은 응답 확인");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ mode: "thorough", context: { useMemory: true } });
  await expect(input).toBeEnabled();
  await page.getByRole("combobox", { name: "응답 모드" }).selectOption("fast");
  await input.fill("빠른 응답 확인");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ mode: "fast" });
});

test("설정된 모델을 직접 선택해 보내고 자동 라우팅으로 돌아온다", async ({ page }) => {
  const { sent } = await mockChat(page);
  const select = page.getByRole("combobox", { name: "모델 선택" });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("");
  // Playwright의 toBeDisabled는 <option disabled>를 활성으로 판정할 수 있어 HTML 속성을 확인한다.
  await expect(select.locator('option[value="offline:7b"]')).toHaveAttribute("disabled", "");
  await select.selectOption("qwen3:8b");
  const input = page.getByRole("textbox", { name: "메시지 입력" });
  await input.fill("모델 직접 선택");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.routing).toEqual({ model: "qwen3:8b" });
  await expect(select).toBeEnabled();
  await select.selectOption("");
  await input.fill("다시 자동 선택");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.routing).toBeUndefined();
});

test("모델 목록 실패 중에도 자동 전송하고 재시도 후 직접 선택한다", async ({ page }) => {
  const { sent } = await mockChat(page);
  let failing = true;
  await page.route("**/v1/models", (route) => failing
    ? route.fulfill({ status: 503, json: { error: { message: "고의 모델 목록 오류" } } })
    : route.fulfill({ json: { models: [{ model: "qwen3:8b", provider: "local", open: false, successRate: 1, ewmaLatencyMs: 1000 }] } }));
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "고의 모델 목록 오류" })).toBeVisible();
  const select = page.getByRole("combobox", { name: "모델 선택" });
  await expect(select).toBeDisabled();
  const input = page.getByRole("textbox", { name: "메시지 입력" });
  await input.fill("목록 오류 중 자동 대화");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.routing).toBeUndefined();
  failing = false;
  await page.getByRole("button", { name: "모델 목록 다시 불러오기" }).click();
  await expect(select).toBeEnabled();
  await select.selectOption("qwen3:8b");
  await input.fill("재시도 후 명시 선택");
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.routing).toEqual({ model: "qwen3:8b" });
});

test("Shift+Enter 줄바꿈과 한글 조합 확정이 전송되지 않는다", async ({ page }) => {
  const { sent } = await mockChat(page);
  const input = page.getByRole("textbox", { name: "메시지 입력" });
  await input.fill("첫 줄");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("첫 줄\n");
  await input.dispatchEvent("compositionstart", { data: "안" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, isComposing: true });
  await expect(input).toBeEnabled();
  expect(sent).toHaveLength(0);
  await input.dispatchEvent("compositionend", { data: "안" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 });
  expect(sent).toHaveLength(0);
  await input.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
});

test("대화 내역은 앱 사이드바에 한 번만 있고 이전 대화를 더 불러온다", async ({ page }, info) => {
  await mockChat(page);
  const nav = page.getByRole("navigation", { name: "주요 메뉴" });
  if (info.project.name === "mobile") await nav.getByRole("button", { name: "대화 내역" }).click();
  const list = nav.getByRole("region", { name: "대화 목록" });
  await expect(list).toBeVisible();
  await expect(page.locator("main .session-list")).toHaveCount(0);
  await list.getByRole("button", { name: "이전 대화 더 보기" }).click();
  await expect(list.getByRole("link", { name: "더 오래된 대화" })).toBeVisible();
  await list.getByRole("link", { name: "이전 대화 테스트" }).click();
  await expect(page).toHaveURL(/#\/chat\/old$/);
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
  await nav.getByRole("button", { name: "+ 새 대화", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.getByText("무엇을 도와드릴까요?", { exact: true })).toBeVisible();
  const bounds = await page.evaluate(() => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const nav = document.querySelector("nav")!.getBoundingClientRect();
    const composer = document.querySelector(".composer")!.getBoundingClientRect();
    return { mainX: main.x, navRight: nav.right, composerBottom: composer.bottom, viewportHeight: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(bounds.overflow).toBeLessThanOrEqual(1);
  expect(bounds.composerBottom).toBeLessThanOrEqual(bounds.viewportHeight);
  if (info.project.name === "desktop") expect(bounds.mainX).toBeGreaterThanOrEqual(bounds.navRight);
});

test("결함 주입: 목록 읽기 실패가 보여도 전송은 계속 가능하다", async ({ page }) => {
  await mockChat(page);
  await page.route("**/v1/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 503, json: { error: { message: "고의 목록 오류" } } });
  });
  await page.reload();
  const toggle = page.getByRole("button", { name: "대화 내역" });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(page.getByRole("alert")).toContainText("고의 목록 오류");
  await page.getByLabel("메시지 입력").fill("목록 실패와 무관한 메시지");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.locator(".messages")).toContainText("확인했습니다.");
});

test("결함 주입: 저장본 재조회 실패 시에도 받은 답변은 남는다", async ({ page }) => {
  const { sent } = await mockChat(page);
  await page.route("**/v1/sessions/*/messages", async (route) => {
    if (route.request().method() !== "GET" || sent.length === 0) return route.fallback();
    await route.fulfill({ status: 503, json: { error: { message: "고의 기록 조회 오류" } } });
  });
  await page.getByLabel("메시지 입력").fill("답변 보존 확인");
  await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByRole("alert")).toContainText("고의 기록 조회 오류");
  await expect(page.locator(".messages")).toContainText("확인했습니다.");
  await expect(page.getByLabel("메시지 입력")).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "응답이 완료되었습니다." })).toBeAttached();
});
