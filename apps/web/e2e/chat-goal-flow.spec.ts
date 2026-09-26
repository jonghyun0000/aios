import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

test("목표·단계·결과를 표시하고 선택한 실행의 명령만 초안에 채운다", async ({ page, request }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: "목표 이어서 하기 화면 회귀" } })).json();
  const run = { id: "bb100000-0000-4000-8000-000000000001", status: "cancelled", summary: "중단했습니다", goal: "계산 파일 만들기",
    created_at: new Date().toISOString(), workspace_root: "/fixture", verification_command: "node sum.js", actions: [
      { id: "file", tool_name: "write_file", arguments: { path: "sum.js" }, purpose: "tool", status: "passed", after_hash: "123456789abc0000", exit_code: null },
    ] };
  const second = { ...run, id: "bb100000-0000-4000-8000-000000000002", goal: "검증 명령 없는 목표", verification_command: null, actions: [] };
  await page.route(`**/v1/sessions/${session.id}/executions`, (route) => route.fulfill({ json: { runs: [run, second] } }));
  let sent = 0;
  await page.route(`**/v1/sessions/${session.id}/messages`, (route) => {
    if (route.request().method() === "POST") sent++;
    return route.continue();
  });
  await login(page); await goRoute(page, `/chat/${session.id}`);
  await page.getByRole("button", { name: /실행 기록/ }).click();
  const first = page.getByTestId("execution-run").first();
  await expect(first.getByTestId("run-goal")).toHaveText(run.goal);
  await expect(first.getByTestId("run-steps")).toContainText("sum.js");
  await expect(first.getByTestId("run-result")).toContainText("123456789abc");
  await first.getByRole("button", { name: "이어서 하기", exact: true }).click();
  await expect(page.getByLabel("도구 사용 허용")).toBeChecked();
  await expect(page.getByLabel("검증 명령", { exact: true })).toHaveValue("node sum.js");
  await expect(page.getByLabel("메시지 입력")).toHaveValue(/이전 실행을 이어서/);
  const other = page.getByTestId("execution-run").nth(1);
  await other.locator("summary").first().click();
  await other.getByRole("button", { name: "이어서 하기", exact: true }).click();
  await expect(page.getByLabel("검증 명령", { exact: true })).toHaveValue("");
  await expect(page.getByTestId("resume-notice")).toContainText(second.goal);
  expect(sent).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: /실행 기록/ }).click();
  await expect(page.getByTestId("run-goal").first()).toHaveText(run.goal);
  await expect(page.getByLabel("메시지 입력")).toHaveValue("");
  expect(sent).toBe(0);
});

// 격리 서비스 하네스가 만든 실제 DB 기록이 있을 때만 등록한다. 합성 응답으로 바꾸지 않는다.
if (process.env.AIOS_GOAL_FLOW_FIXTURE) {
  test("실제 중단·재개 기록의 목표와 검증 결과가 새로고침 후에도 남는다", async ({ page }) => {
    const fixture = JSON.parse(process.env.AIOS_GOAL_FLOW_FIXTURE!) as { session: string; goal: string };
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page); await goRoute(page, `/chat/${fixture.session}`);
    for (let pass = 0; pass < 2; pass++) {
      await page.getByRole("button", { name: /실행 기록/ }).click();
      const completed = page.getByTestId("execution-run").filter({ has: page.getByTestId("run-resumed") });
      await completed.locator("summary").first().click();
      await expect(completed.getByTestId("run-goal")).toHaveText(fixture.goal);
      await expect(completed.getByTestId("run-steps")).toContainText("종료 코드 0");
      await expect(completed.getByTestId("run-result")).toContainText("검증 통과");
      await expect(completed.getByRole("button", { name: "이어서 하기", exact: true })).toHaveCount(0);
      if (pass === 0) await page.reload();
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/Volumes/T7/bigdata/tmp/goal-flow-${test.info().project.name}.png`, fullPage: true });
  });
}
