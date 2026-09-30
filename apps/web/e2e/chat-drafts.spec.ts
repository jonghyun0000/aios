import { test, expect, type APIRequestContext } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/** docs/44: 대화별 입력 초안. 모델을 부르지 않는 정확 계산(17*23+41)으로 전송 경로를 확인한다. */
async function sessions(request: APIRequestContext, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(((await (await request.post("/v1/sessions", { data: { title: `초안 시험 ${Date.now()}-${i}` } })).json()) as { id: string }).id);
  return out;
}
const trash = async (request: APIRequestContext, ids: string[]) => { for (const id of ids) await request.patch(`/v1/sessions/${id}`, { data: { deleted: true } }); };

test("초안은 대화마다 따로 남고, 새로고침·다른 화면 뒤에도 돌아오며, 전송하면 지워진다", async ({ page, request }) => {
  const [a, b] = await sessions(request, 2);
  try {
    await login(page); await goRoute(page, `/chat/${a}`);
    const box = page.getByLabel("메시지 입력");
    await box.fill("대화 A 초안");
    await goRoute(page, `/chat/${b}`);
    await expect(box).toHaveValue("");
    await box.fill("대화 B 초안");
    await goRoute(page, `/chat/${a}`);
    await expect(box).toHaveValue("대화 A 초안");
    await page.reload(); await expect(box).toHaveValue("대화 A 초안");
    await goRoute(page, "/data"); await goRoute(page, `/chat/${b}`);
    await expect(box).toHaveValue("대화 B 초안");
    // 새 대화(선택 전) 초안도 따로다.
    await goRoute(page, "/chat"); await expect(box).toHaveValue("");
    await box.fill("새 대화 초안"); await goRoute(page, `/chat/${a}`); await expect(box).toHaveValue("대화 A 초안");
    await goRoute(page, "/chat"); await expect(box).toHaveValue("새 대화 초안");

    // 전송하면 그 대화의 초안이 지워진다(새로고침 뒤에도 비어 있다). 다른 대화 초안은 남는다.
    await goRoute(page, `/chat/${a}`);
    await box.fill("17*23+41"); await box.press("Enter");
    await expect(page.locator(".messages")).toContainText("432");
    await expect(box).toHaveValue("");
    await page.reload(); await expect(box).toHaveValue("");
    await goRoute(page, `/chat/${b}`); await expect(box).toHaveValue("대화 B 초안");
    await box.fill("");
  } finally { await trash(request, [a!, b!]); }
});

test("새 대화에서 보내 대화가 생기면 새 대화 초안이 지워진다", async ({ page, request }) => {
  let created: string | undefined;
  try {
    await login(page); await goRoute(page, "/chat");
    const box = page.getByLabel("메시지 입력");
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/sessions" && r.request().method() === "POST");
    await box.fill("17*23+41"); await box.press("Enter");
    created = ((await (await response).json()) as { id: string }).id;
    await expect(page.locator(".messages")).toContainText("432");
    await goRoute(page, "/chat"); await expect(box).toHaveValue("");
  } finally { if (created) await trash(request, [created]); }
});

test("결함 주입: 전송 시작 전 실패는 초안을 남기고, 저장소가 막혀도 채팅은 동작한다", async ({ page, request }) => {
  const [a] = await sessions(request, 1);
  try {
    await login(page); await goRoute(page, `/chat/${a}`);
    const box = page.getByLabel("메시지 입력");
    await page.route(`**/v1/sessions/${a}/messages`, (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "고의 전송 실패" } } }) : route.continue());
    await box.fill("실패해도 남아야 하는 초안"); await box.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "고의 전송 실패" })).toBeVisible();
    await expect(box).toHaveValue("실패해도 남아야 하는 초안");
    await page.unroute(`**/v1/sessions/${a}/messages`);
    await page.reload(); await expect(box).toHaveValue("실패해도 남아야 하는 초안");

    // 사생활 보호 모드처럼 저장소 쓰기가 막힌 경우: 알림만 하고 입력·전송은 된다.
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
    await box.fill("");
    await box.fill("17*23+41");
    await expect(page.getByTestId("draft-notice")).toContainText("보관할 수 없습니다");
    await box.press("Enter");
    await expect(page.locator(".messages")).toContainText("432");
  } finally { await trash(request, [a!]); }
});
