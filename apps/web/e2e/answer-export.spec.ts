import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/** docs/45: 답변·대화 내보내기. 대화는 실제 서버에서 만들고, 기록 응답만 근거가 담긴 고정 메시지로 둔다. */
const FILE = "10000000-0000-4000-8000-000000000003";
const messages = [
  { id: "u1", role: "user", content: { text: "제품계획 자료에서 출시일은?" }, created_at: "2026-09-30T01:01:00Z" },
  { id: "a1", role: "assistant", created_at: "2026-09-30T01:01:09Z", content: { text: "출시일은 2026-11-03 입니다. ```코드``` 도 포함", evidence: {
    version: 1, referenceMode: "matched", excerpted: false, files: [{ id: FILE, name: "제품계획.md" }],
    sources: [{ id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 40, endLine: 40, excerpt: "출시일: 2026-11-03\n" }] } } },
];

test("답변 복사·Markdown 저장·대화 내보내기와 복사 실패 표시", async ({ page, request, context }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: `출시 계획/검토: ${Date.now()}` } })).json() as { id: string };
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.route(`**/v1/sessions/${session.id}/messages`, (route) => route.request().method() === "GET" ? route.fulfill({ json: { messages } }) : route.continue());
    await login(page); await goRoute(page, `/chat/${session.id}`);
    const actions = page.getByRole("group", { name: "답변 내보내기" });
    await expect(actions).toHaveCount(1);

    await actions.getByRole("button", { name: "복사" }).click();
    await expect(page.getByTestId("export-notice")).toContainText("복사했습니다");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("## 질문"); expect(copied).toContain("제품계획 자료에서 출시일은?");
    expect(copied).toContain("````\n출시일은 2026-11-03 입니다. ```코드``` 도 포함\n````");
    expect(copied).toContain("**R1 · 제품계획.md · 40행**"); expect(copied).toContain("보증이 아닙니다");

    const [answerFile] = await Promise.all([page.waitForEvent("download"), actions.getByRole("button", { name: "Markdown 저장" }).click()]);
    expect(answerFile.suggestedFilename()).toMatch(/^출시 계획 검토 \d+-답변-\d{12}\.md$/);
    expect(await readFile((await answerFile.path()), "utf8")).toBe(copied);

    const [conversation] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "대화 내보내기" }).click()]);
    expect(conversation.suggestedFilename()).toMatch(/-대화-\d{12}\.md$/);
    const whole = await readFile((await conversation.path()), "utf8");
    expect(whole).toMatch(/^# 출시 계획\/검토: \d+\n/); expect(whole).toContain("메시지 2개"); expect(whole).toContain("#### 근거");
    await expect(page.getByTestId("export-notice")).toContainText("대화 전체");

    // 결함 주입: 클립보드 거부는 성공으로 보이지 않는다.
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("권한 거부")); });
    await actions.getByRole("button", { name: "복사" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "복사하지 못했습니다" })).toBeVisible();
    await expect(page.getByTestId("export-notice")).not.toContainText("복사했습니다");
    await expect(page.getByLabel("메시지 입력")).toBeEnabled();
  } finally { await request.patch(`/v1/sessions/${session.id}`, { data: { deleted: true } }); }
});

test("답변이 없는 대화는 내보낼 것이 없다", async ({ page, request }) => {
  const session = await (await request.post("/v1/sessions", { data: { title: `빈 대화 ${Date.now()}` } })).json() as { id: string };
  try {
    await login(page); await goRoute(page, `/chat/${session.id}`);
    await expect(page.getByRole("button", { name: "대화 내보내기" })).toBeDisabled();
    await expect(page.getByRole("group", { name: "답변 내보내기" })).toHaveCount(0);
  } finally { await request.patch(`/v1/sessions/${session.id}`, { data: { deleted: true } }); }
});
