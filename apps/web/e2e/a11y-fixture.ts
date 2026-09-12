import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";

declare global { interface Window { axe: typeof axe } }

export const SESSION_ID = "a1100000-0000-4000-8000-000000000001";
const now = "2026-09-12T10:00:00.000Z";
export async function fixtureApp(page: Page) {
  const session = { id: SESSION_ID, title: "접근성 시험 대화", updated_at: now, project_id: null, deleted_at: null };
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: `msg-${i}`, role: i % 2 ? "assistant" : "user", content: { text: `메시지 ${i} · ${"키보드로 읽을 수 있는 긴 대화. ".repeat(10)}` }, created_at: now }));
  const action = { id: "a1100000-0000-4000-8000-000000000002", tool_name: "write_file", arguments: { path: "sample.txt" }, status: "pending", purpose: "tool", output: "", exit_code: null, checkpoint: true, decided_at: null as string | null, restored_at: null as string | null, before_hash: "before", after_hash: "after", expires_at: now, preview: { before: "기존 내용\n".repeat(60), after: "제안 내용\n".repeat(60) } };
  const run = { id: "a11y-run", status: "running", summary: "승인 전에는 파일을 바꾸지 않습니다.", created_at: now, workspace_root: "/synthetic/workspace", actions: [action] };
  const fixture = { execution: false, approvalFails: false, restoreFails: true, fileFails: false, sessionFails: false, operationsFail: false, preferencesReset: false, sent: [] as Array<{ content: string; context: { useMemory: boolean } }>, unexpected: [] as string[], writes: [] as string[], socket: null as WebSocketRoute | null };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const error = (message: string, status = 503) => route.fulfill({ status, json: { error: { code: "synthetic_failure", message } } });
    if (method !== "GET") fixture.writes.push(`${method} ${path}`);
    if (path === "/v1/me") return route.fulfill({ json: { orgId: "a1100000-0000-4000-8000-000000000003", userId: null, role: "owner", via: "local", workspaceRoot: "/synthetic/workspace" } });
    if (path === "/v1/sessions" && method === "GET") return route.fulfill({ json: { sessions: [session], nextCursor: null } });
    if (path === `/v1/sessions/${SESSION_ID}/messages` && method === "GET") return route.fulfill({ json: { messages } });
    if (path === `/v1/sessions/${SESSION_ID}/messages` && method === "POST") {
      const body = request.postDataJSON() as { content: string; context: { useMemory: boolean } };
      fixture.sent.push(body);
      if (body.content.trim() === "이 대화의 답변 선호를 초기화해줘.") fixture.preferencesReset = true;
      const enabled = body.context.useMemory;
      messages.push({ id: `sent-${messages.length}`, role: "user", content: { text: body.content }, created_at: now }, { id: `reply-${messages.length}`, role: "assistant", content: { text: "실제 모델을 호출하지 않은 합성 응답입니다." }, created_at: now });
      const events = [
        { type: "workspace_context", historyCount: enabled ? 20 : 0, files: ["기존 참고자료.txt"], excerpted: true, referenceMode: "matched", sources: [{ id: "file-a11y", fileName: "기존 참고자료.txt", startLine: 12, endLine: 15 }], memory: { enabled, historyLimit: 100, preferenceScanLimit: 500, scannedUserMessages: enabled ? 121 : 0, restoredPreferences: !enabled || fixture.preferencesReset ? [] : [{ kind: "language", value: "ko" }, { kind: "format", value: "bullets" }, { kind: "length", value: "concise" }] } },
        { type: "text_delta", text: "실제 모델을 호출하지 않은 합성 응답입니다." },
        { type: "done", stopReason: "end_turn" },
      ];
      return route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    if (path === `/v1/sessions/${SESSION_ID}/workspace`) return route.fulfill({ json: { session, files: [{ id: "file-a11y", name: "기존 참고자료.txt", project_id: null, bytes: 64 }] } });
    if (path === "/v1/projects") return route.fulfill({ json: { projects: [] } });
    if (path === `/v1/sessions/${SESSION_ID}/files` && method === "POST") return fixture.fileFails ? error("시험용 파일 저장 실패 · 기존 자료는 보존됩니다.") : route.fulfill({ json: { id: "file-new" } });
    if (path === `/v1/sessions/${SESSION_ID}` && method === "PATCH") return error("시험용 이름 저장 실패");
    if (path === `/v1/sessions/${SESSION_ID}/executions`) return route.fulfill({ json: { runs: fixture.execution ? [run] : [] } });
    if (path.endsWith(`/${action.id}/approval`) && method === "POST") {
      if (fixture.approvalFails) return error("시험용 승인 저장 실패");
      const approve = request.postDataJSON().approve === true;
      action.status = approve ? "passed" : "rejected"; action.decided_at = now; run.status = approve ? "unverified" : "cancelled"; run.summary = approve ? "파일 저장 확인 · 동작 미검증" : "거절했습니다.";
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith(`/${action.id}/restore`) && method === "POST") {
      if (fixture.restoreFails) return error("파일이 이후 변경됐습니다. 현재 내용을 보존합니다.", 409);
      action.restored_at = now; action.status = "restored";
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/v1/auth/session") return error(fixture.sessionFails ? "시험용 세션 조회 실패" : "브라우저 세션 없음", fixture.sessionFails ? 503 : 401);
    if (path === "/v1/local/operations") return fixture.operationsFail ? error("시험용 운영 기록 조회 실패") : route.fulfill({ json: { version: 1, mode: "local-read-only", observedAt: now, backupRoot: "/Volumes/T7/bigdata/backups/local", history: { state: "empty" } } });
    fixture.unexpected.push(`${method} ${path}`);
    // 미지정 요청을 실제 서버로 통과시키지 않는다. CI와 사용자 DB를 모두 보호한다.
    return error("합성 시험 범위 밖 요청", 400);
  });
  await page.routeWebSocket("**/v1/collab**", (socket) => { fixture.socket = socket; socket.onMessage(() => { /* 합성 연결이며 실제 서버로 전달하지 않는다. */ }); });
  return fixture;
}

export async function openFixtureChat(page: Page) {
  await page.goto(`/#/chat/${SESSION_ID}`);
  await expect(page.getByRole("heading", { name: "채팅", exact: true })).toBeVisible();
  await expect(page.locator(".messages")).toContainText("메시지 19");
}

export async function audit(page: Page, label: string) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
  const violations = result.violations.map((rule) => ({ id: rule.id, nodes: rule.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) }));
  console.log(`${label}: axe ${result.passes.length}개 규칙 통과, 위반 ${violations.length}개, 수동확인 ${result.incomplete.length}개`);
  const fileLabel = label.replace(/[\\/:*?"<>|]/g, "-");
  const reportPath = test.info().outputPath(`${fileLabel}-axe.json`);
  await writeFile(reportPath, JSON.stringify({ label, violations, passes: result.passes.map((rule) => rule.id), incomplete: result.incomplete.map((rule) => ({ id: rule.id, targets: rule.nodes.map((node) => node.target) })) }, null, 2));
  await test.info().attach(`${label}-axe`, { path: reportPath, contentType: "application/json" });
  const screenPath = test.info().outputPath(`${fileLabel}-screen.png`);
  await page.screenshot({ path: screenPath, fullPage: true });
  await test.info().attach(`${label}-screen`, { path: screenPath, contentType: "image/png" });
  expect(result.passes.length, "자동 검사 표본이 없어서는 안 된다").toBeGreaterThan(15);
  expect(violations, label).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${label}: 가로 넘침`).toBeLessThanOrEqual(1);
  return result;
}
