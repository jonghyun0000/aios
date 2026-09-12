import { test, expect } from "@playwright/test";
import { audit, fixtureApp, openFixtureChat } from "./a11y-fixture.js";

for (const scheme of ["light", "dark"] as const) test.describe(`실제 앱 접근성 · 합성 API · ${scheme}`, () => {
  test.use({ colorScheme: scheme });

  test("긴 대화는 키보드로 읽고 본문 바로가기를 사용할 수 있다", async ({ page }) => {
    const fixture = await fixtureApp(page); await openFixtureChat(page);
    const messages = page.getByRole("region", { name: "대화 메시지", exact: true });
    await messages.focus();
    const before = await messages.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(0);
    await page.keyboard.press("Home");
    await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(0);
    await page.getByRole("link", { name: "본문으로 건너뛰기" }).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
    await audit(page, `채팅 ${scheme}`);
    expect(fixture.unexpected).toEqual([]); expect(fixture.writes).toEqual([]);
  });

  test("낮은 노트북 창에서도 사이드바 대화 내역을 키보드로 열 수 있다", async ({ page }) => {
    const fixture = await fixtureApp(page);
    await page.setViewportSize({ width: 1280, height: 600 }); await openFixtureChat(page);
    const conversation = page.getByRole("link", { name: "접근성 시험 대화", exact: true });
    // 한 항목짜리 fixture에 빈 공간을 강제하지 않는다. 실제 대화 링크 한 줄 전체가 보여야 한다.
    const rowHeight = (await conversation.boundingBox())!.height;
    expect(await page.locator(".session-list").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(rowHeight);
    await conversation.focus(); await expect(conversation).toBeInViewport({ ratio: 1 }); await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "대화 메시지", exact: true })).toBeVisible();
    await audit(page, `낮은 노트북 창 ${scheme}`);
    expect(fixture.unexpected).toEqual([]); expect(fixture.writes).toEqual([]);
  });

  test("자료·이름 모달은 초점을 가두고 오류와 원래 버튼을 보존한다", async ({ page }) => {
    const fixture = await fixtureApp(page); fixture.fileFails = true;
    await openFixtureChat(page);
    const trigger = page.getByRole("button", { name: "자료·프로젝트", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "자료·프로젝트", exact: true });
    await expect(dialog.getByLabel("참고 파일 선택")).toBeEnabled();
    await dialog.getByLabel("참고 파일 선택").setInputFiles({ name: "시험.txt", mimeType: "text/plain", buffer: Buffer.from("합성 자료") });
    await expect(dialog.getByRole("alert")).toContainText("시험용 파일 저장 실패");
    await expect(dialog.locator(".reference-list")).toContainText("기존 참고자료.txt");
    await dialog.getByRole("button", { name: "닫기", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await audit(page, `자료 오류 모달 ${scheme}`);
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    const history = page.getByRole("button", { name: "대화 내역", exact: true });
    if (await history.isVisible() && await history.getAttribute("aria-expanded") === "false") await history.click();
    const manage = page.getByRole("button", { name: "접근성 시험 대화 대화 관리", exact: true });
    await manage.click();
    await expect(page.getByLabel("대화 이름")).toBeFocused();
    await page.getByLabel("대화 이름").fill("보존할 새 제목"); await page.getByRole("button", { name: "이름 저장" }).click();
    await expect(page.getByRole("alert")).toContainText("시험용 이름 저장 실패");
    await expect(page.getByLabel("대화 이름")).toHaveValue("보존할 새 제목");
    await page.keyboard.press("Escape"); await expect(manage).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  });

  test("승인 오류·긴 변경 비교·복구 충돌을 키보드로 확인한다", async ({ page }) => {
    const fixture = await fixtureApp(page); fixture.execution = true; fixture.approvalFails = true;
    await openFixtureChat(page);
    await page.getByRole("button", { name: "이번 작업 승인", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("시험용 승인 저장 실패");
    await audit(page, `승인 대기/오류 ${scheme}`);
    const preview = page.getByRole("region", { name: "변경 후 전체 내용", exact: true });
    await preview.focus(); await page.keyboard.press("End");
    await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    fixture.approvalFails = false;
    await page.getByRole("button", { name: "이번 작업 승인", exact: true }).click();
    await expect(page.getByTestId("execution-summary")).toContainText("동작 미검증");
    await expect(page.locator(".execution-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".execution-toggle")).toBeFocused();
    await page.getByRole("button", { name: "이 변경 복구", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "파일 변경 복구" });
    await dialog.getByRole("button", { name: "확인하고 복구" }).click();
    await expect(dialog.getByRole("alert")).toContainText("현재 내용을 보존");
    await audit(page, `복구 충돌 ${scheme}`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "이 변경 복구", exact: true })).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  });

  test("설정 조회 장애는 정상 상태와 구분하고 재시도한다", async ({ page }) => {
    const fixture = await fixtureApp(page); fixture.sessionFails = true; fixture.operationsFail = true;
    await page.goto("/#/settings");
    await expect(page.getByRole("alert").filter({ hasText: "시험용 세션 조회 실패" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "시험용 운영 기록 조회 실패" })).toBeVisible();
    await audit(page, `설정 조회 오류 ${scheme}`);
    fixture.sessionFails = false; fixture.operationsFail = false;
    await page.getByRole("button", { name: "세션 정보 다시 확인" }).click();
    await page.getByRole("button", { name: "운영 기록 새로고침" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("아직 복원 검사를 하지 않았습니다.")).toBeVisible();
    await audit(page, `설정 정상 ${scheme}`);
    expect(fixture.unexpected).toEqual([]); expect(fixture.writes).toEqual([]);
  });

  test("협업은 Enter로 열고 이름·단절·메모리 보관 한계를 알린다", async ({ page }) => {
    const fixture = await fixtureApp(page);
    await page.goto("/#/collab");
    await page.getByLabel("문서 이름").fill("a11y-synthetic-only"); await page.getByLabel("문서 이름").press("Enter");
    await expect(page).toHaveURL(/#\/collab\/a11y-synthetic-only$/);
    const editor = page.getByRole("textbox", { name: "a11y-synthetic-only 협업 문서 내용", exact: true });
    await editor.fill("서버에 보내지 않는 합성 편집");
    await expect(page.getByRole("status").filter({ hasText: "연결됨" })).toBeVisible();
    await fixture.socket!.close({ code: 4401, reason: "synthetic disconnect" });
    await expect(page.getByRole("alert")).toContainText("이 탭의 메모리");
    await expect(page.getByRole("alert")).toContainText("잃을 수 있습니다");
    await expect(editor).toHaveValue("서버에 보내지 않는 합성 편집");
    await audit(page, `협업 단절 ${scheme}`);
    expect(fixture.unexpected).toEqual([]); expect(fixture.writes).toEqual([]);
  });

  test("결함 주입은 키보드 스크롤 퇴행을 실제로 검출한다", async ({ page }) => {
    await fixtureApp(page); await openFixtureChat(page);
    await audit(page, `결함 주입 전 ${scheme}`);
    await page.locator(".messages").evaluate((element) => element.removeAttribute("tabindex"));
    const broken = await page.evaluate(async () => window.axe.run(document, { runOnly: ["scrollable-region-focusable"] }));
    expect(broken.violations.some((rule) => rule.id === "scrollable-region-focusable" && rule.nodes.some((node) => node.target.includes(".messages")))).toBe(true);
    await page.locator(".messages").evaluate((element) => element.setAttribute("tabindex", "0"));
    await audit(page, `결함 복구 후 ${scheme}`);
  });

  test("기억 끄기·답변 선호 초기화와 출처 범위를 정직하게 표시한다", async ({ page }) => {
    const fixture = await fixtureApp(page); await openFixtureChat(page);
    await page.getByText("기억·참고자료 사용 범위", { exact: true }).click();
    const memory = page.getByLabel("이전 대화와 답변 선호 사용", { exact: true });
    const composer = page.getByRole("textbox", { name: "메시지 입력", exact: true });
    await memory.uncheck(); await composer.fill("기억 없이 답변"); await composer.press("Enter");
    await expect(page.getByTestId("workspace-memory")).toContainText("기억 끔");
    await expect(page.getByTestId("workspace-memory")).toContainText("채팅 저장은 유지");
    expect(fixture.sent[0]?.context.useMemory).toBe(false);
    await memory.check(); await composer.fill("기억과 자료 범위 알려줘"); await composer.press("Enter");
    await expect(page.getByTestId("workspace-memory")).toContainText("한국어 · 목록 · 간결하게");
    await expect(page.getByTestId("workspace-memory")).toContainText("121개 검사 (최근 최대 500개)");
    await page.getByTestId("workspace-sources").locator("summary").click();
    await expect(page.getByTestId("workspace-sources")).toContainText("기존 참고자료.txt · 12–15행");
    await expect(page.getByTestId("workspace-sources")).toContainText("자료 전체 검증을 보장하지 않습니다");
    expect(await page.locator(".messages").evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(120);
    await composer.focus();
    await expect(composer).toBeInViewport();
    await audit(page, `기억과 출처 ${scheme}`);
    await composer.fill("보존할 초안");
    const reset = page.getByRole("button", { name: "답변 선호 초기화 문장 넣기" });
    await expect(reset).toBeDisabled(); await expect(composer).toHaveValue("보존할 초안");
    expect(fixture.sent).toHaveLength(2);
    await composer.fill(""); await reset.click();
    await expect(composer).toHaveValue("이 대화의 답변 선호를 초기화해줘.");
    await expect(composer).toBeFocused(); expect(fixture.sent).toHaveLength(2);
    await composer.press("Enter");
    await expect(page.getByTestId("workspace-memory")).toContainText("답변 선호 0개 복원");
    await expect(page.locator(".messages")).toContainText("메시지 0");
    expect(fixture.unexpected).toEqual([]);
  });

  test("좁은 화면 대화 메뉴를 키보드로 열고 닫아도 초점을 잃지 않는다", async ({ page }) => {
    await fixtureApp(page); await page.setViewportSize({ width: 320, height: 844 }); await openFixtureChat(page);
    const toggle = page.getByRole("button", { name: "대화 내역", exact: true });
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("searchbox", { name: "대화 검색" }).focus(); await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("link", { name: "접근성 시험 대화", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(toggle).toBeFocused();
    await audit(page, `320px 대화 메뉴 ${scheme}`);
  });
});
