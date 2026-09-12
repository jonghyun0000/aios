import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

test("승인 전 변경 내용·단일 승인·복구 충돌을 표시한다", async ({ page, request }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: `3단계 화면 검증 ${Date.now()}` } })).json();
  const action = { id: "b8100000-0000-4000-8000-000000000001", tool_name: "write_file", arguments: { path: "note.txt" }, status: "pending", purpose: "tool", output: "", exit_code: null, checkpoint: true, decided_at: null as string | null, restored_at: null, before_hash: "before", after_hash: "after", expires_at: new Date(Date.now() + 300000).toISOString(), preview: { before: "기존 내용", after: '<script>alert("unsafe")</script>\n새 내용' } };
  const run = { id: "run", status: "running", summary: "", created_at: new Date().toISOString(), workspace_root: "/test-workspace", actions: [action] };
  await page.route(`**/v1/sessions/${session.id}/executions`, (route) => route.fulfill({ json: { runs: [run] } }));
  await login(page); await goRoute(page, `/chat/${session.id}`);
  await expect(page.getByRole("button", { name: "이번 작업 승인", exact: true })).toBeVisible();
  await expect(page.locator(".change-preview")).toContainText("기존 내용");
  await expect(page.locator(".change-preview")).toContainText('<script>alert("unsafe")</script>');
  await page.route("**/executions/*/approval", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ approve: true });
    action.status = "passed"; action.decided_at = new Date().toISOString(); run.status = "unverified"; run.summary = "파일 저장·내용 해시 확인. 동작 미검증.";
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "이번 작업 승인", exact: true }).click();
  await expect(page.getByRole("button", { name: /실행 기록/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("execution-summary")).toContainText("동작 미검증");
  await page.route("**/executions/*/restore", (route) => route.fulfill({ status: 409, json: { error: { code: "file_conflict", message: "파일이 이후 변경됐습니다. 현재 내용을 보존합니다." } } }));
  await page.getByRole("button", { name: "이 변경 복구", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "파일 변경 복구" });
  await dialog.getByRole("button", { name: "확인하고 복구" }).click();
  await expect(dialog.getByRole("alert")).toContainText("현재 내용을 보존");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  const bounds = await page.locator(".execution-panel").evaluate((el) => ({ overflow: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right, viewport: innerWidth }));
  expect(bounds.overflow).toBeLessThanOrEqual(1); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
});

test("고의 승인 통신 실패를 성공으로 표시하지 않고 거절을 재시도할 수 있다", async ({ page, request }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: `3단계 승인 오류 ${Date.now()}` } })).json();
  const action = { id: "b8100000-0000-4000-8000-000000000002", tool_name: "run_command", arguments: { command: "exit 42", cwd: "." }, status: "pending", purpose: "verification", output: "", exit_code: null, checkpoint: false };
  await page.route(`**/v1/sessions/${session.id}/executions`, (route) => route.fulfill({ json: { runs: [{ id: "run", status: "running", summary: "", created_at: new Date().toISOString(), workspace_root: "/test", actions: [action] }] } }));
  await page.route("**/executions/*/approval", (route) => route.fulfill({ status: 503, json: { error: { message: "고의 승인 저장 실패" } } }));
  await login(page); await goRoute(page, `/chat/${session.id}`);
  await expect(page.locator(".execution-panel")).toContainText("exit 42");
  await page.getByRole("button", { name: "거절하고 중단" }).click();
  await expect(page.getByRole("alert")).toContainText("고의 승인 저장 실패");
  await expect(page.getByRole("button", { name: "이번 작업 승인", exact: true })).toBeEnabled();
  await page.route("**/executions/*/approval", async (route) => { expect(route.request().postDataJSON()).toEqual({ approve: false }); action.status = "rejected"; await route.fulfill({ json: { ok: true } }); });
  await page.getByRole("button", { name: "거절하고 중단" }).click();
  await expect(page.getByRole("button", { name: "이번 작업 승인", exact: true })).toHaveCount(0);
  await expect(page.locator(".execution-panel")).toContainText("작업을 거절했습니다.");
});

test("고의 SSE 조기 종료는 완료가 아니라 연결 오류다", async ({ page }) => {
  await login(page); await goRoute(page, "/chat");
  await page.route("**/v1/sessions/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"text_delta","text":"완료라고 주장하는 일부 답변"}\n\n' }) : route.continue());
  await page.getByLabel("메시지 입력").fill("테스트 요청"); await page.getByLabel("메시지 입력").press("Enter");
  await expect(page.getByRole("alert")).toContainText("완료 확인 전에 연결이 끊겼습니다");
  await expect(page.getByLabel("메시지 입력")).toHaveValue("테스트 요청");
});

test("고의 실행 기록 형식 오류가 채팅 화면 전체를 깨뜨리지 않는다", async ({ page, request }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: `3단계 잘못된 기록 ${Date.now()}` } })).json();
  await page.route(`**/v1/sessions/${session.id}/executions`, (route) => route.fulfill({ json: { sessions: [] } }));
  await login(page); await goRoute(page, `/chat/${session.id}`);
  await expect(page.getByRole("alert")).toContainText("실행 기록 응답 형식");
  await expect(page.getByLabel("메시지 입력")).toBeEnabled();
  await expect(page.getByRole("heading", { name: "채팅", exact: true })).toBeVisible();
});
