#!/usr/bin/env node
/* global window, Storage, document, innerWidth, localStorage, sessionStorage */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDemo } from "./serve-public-demo.mjs";
import { auditDemoBuild, validateDemoPolicy } from "./public-demo-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("@playwright/test");
const build = await auditDemoBuild(root);
const results = [];
let server;
let browser;
const artifacts = process.env.AIOS_DEMO_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
const record = (name) => { results.push({ name, status: "passed" }); console.log(`PASS ${name}`); };

try {
  const external = process.env.AIOS_DEMO_URL;
  if (external && new URL(external).protocol !== "https:") throw new Error("원격 검증은 HTTPS 공개 URL만 허용합니다.");
  if (external && ["username", "password", "search", "hash"].some(key => new URL(external)[key])) throw new Error("인증 정보나 임시 공유 토큰 없는 공개 주소를 사용하세요.");
  if (!external) server = await serveDemo({ port: 0 });
  const url = external ?? `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  assert.equal(response.status, 200);
  const expectedHeaders = validateDemoPolicy(JSON.parse(await readFile(join(root, "vercel.json"), "utf8")));
  for (const [key, value] of Object.entries(expectedHeaders)) assert.equal(response.headers.get(key), value, key);
  // 예전 배포의 화면도 통과하는 거짓 양성을 막는다. 공개 바이트가 이번 빌드와 같아야 한다.
  for (const file of build.files) {
    const deployed = await fetch(new URL(file.path, url), { signal: AbortSignal.timeout(20_000), redirect: "error" });
    assert.equal(deployed.status, 200, file.path);
    const bytes = Buffer.from(await deployed.arrayBuffer());
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  record("HTTP 200·전체 보안 헤더·현재 빌드와 공개 바이트 일치");
  for (const path of ["/.env", "/v1/me", "/not-a-real-page"]) {
    const missing = await fetch(new URL(path, url), { signal: AbortSignal.timeout(20_000), redirect: "manual" });
    assert.equal(missing.status, 404, path);
  }
  record("비밀·API·없는 페이지는 404");

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const label = viewport.width < 500 ? "mobile" : "desktop";
    const context = await browser.newContext({ viewport, locale: "ko-KR", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = []; const failed = []; const sensitiveRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => failed.push(request.url()));
    page.on("request", request => {
      if (["fetch", "xhr", "websocket", "eventsource"].includes(request.resourceType()) || new URL(request.url()).origin !== new URL(url).origin) sensitiveRequests.push(request.url());
    });
    await page.addInitScript(() => {
      window.__demoStorageWrites = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) { window.__demoStorageWrites++; return set.apply(this, args); };
    });
    await page.goto(url, { waitUntil: "networkidle" });
    const id = name => page.getByTestId(`demo-${name}`);
    const phase = async text => { await id("status").filter({ hasText: text }).waitFor(); };
    const file = () => id("file-content").textContent();
    const select = async name => {
      if (!(await id(`scenario-${name}`).isVisible())) await page.getByRole("button", { name: "시나리오 메뉴", exact: true }).click();
      await id(`scenario-${name}`).click();
    };
    await page.getByText("공개 체험 데모 · 실제 AI 응답·파일 실행 아님", { exact: true }).waitFor();
    await phase("샘플 준비");
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.locator("html").getAttribute("lang"), "ko");
    assert.ok(await page.locator("main").isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    if (artifacts) await page.screenshot({ path: join(artifacts, `${label}-start.png`), fullPage: true });
    record(`${label}: 첫 화면·명시적 데모 안내·반응형 가로 넘침 없음`);

    const initial = await file();
    await id("propose").click(); await phase("승인 대기");
    assert.equal(await file(), initial);
    await id("reject").click(); await phase("거절됨");
    assert.equal(await file(), initial);
    record(`${label}: 승인 전·거절 후 가상 파일 보존`);

    await id("propose").click(); await id("approve").click(); await phase("가상 수정 · 미검증");
    assert.notEqual(await file(), initial);
    assert.equal(await id("approve").count(), 0);
    await id("verify").click(); await phase("샘플 검증 통과");
    await id("restore").click(); await phase("원본 복구 · 이전 검증 무효");
    assert.equal(await file(), initial);
    assert.match(await id("verification-results").textContent(), /현재 파일의 결과가 아닙니다/);
    record(`${label}: 승인→텍스트 검증→원본 복구와 옛 검증 무효화`);

    await select("failure"); await id("propose").click(); await id("approve").click();
    await id("verify").click(); await phase("샘플 검증 실패");
    assert.match(await id("verification-results").textContent(), /불일치/);
    assert.match(await file(), /출시일: 미정/);
    await id("restore").click(); assert.equal(await file(), initial);
    record(`${label}: 실제 날짜 결함을 검증 실패로 검출`);

    await select("conflict"); await id("propose").click(); await id("approve").click(); await id("verify").click();
    await id("manual-edit").click(); const manual = await file();
    assert.match(manual, /직접 남긴 메모/);
    await id("restore").click(); await phase("복구 차단 · 현재 내용 보존");
    assert.equal(await file(), manual);
    assert.equal(await id("restore").isDisabled(), true);
    record(`${label}: 수동 변경 뒤 복구 거부·내용 보존`);

    await select("normal"); await phase("원본 복구");
    await id("reset").click(); await phase("샘플 준비");
    assert.equal(await id("propose").isEnabled(), true);
    assert.equal(await id("approve").count(), 0);
    record(`${label}: 시나리오별 상태 격리·전체 초기화`);

    const input = id("message-input");
    await input.fill("줄 하나"); await input.press("Shift+Enter"); await page.keyboard.insertText("둘");
    assert.match(await input.inputValue(), /\n/);
    await input.fill("한글 조합");
    await input.dispatchEvent("compositionstart"); await input.press("Enter");
    // 합성 composition 이벤트는 OS IME가 아니라 textarea 기본 줄바꿈을 만들 수 있다.
    // 검증할 계약은 ‘조합 Enter로 전송/초기화되지 않음’이다.
    assert.equal((await input.inputValue()).trim(), "한글 조합");
    assert.equal(await page.getByRole("log").getByText("한글 조합", { exact: true }).count(), 0);
    await input.dispatchEvent("compositionend"); await input.press("Enter");
    assert.equal(await input.inputValue(), "");
    await page.getByRole("log").getByText("한글 조합", { exact: true }).waitFor();
    record(`${label}: Enter 전송·Shift+Enter·IME 조합 보호`);

    const attack = '<img src=x onerror="window.__demoUnsafe=true">';
    await input.fill(attack); await id("send").click();
    await page.getByRole("log").getByText(attack, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__demoUnsafe === true), false);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(await input.getAttribute("maxlength"), "800");
    record(`${label}: 사용자 입력을 HTML로 실행하지 않음·길이 제한`);

    await page.reload({ waitUntil: "networkidle" }); await phase("샘플 준비");
    assert.equal(await page.getByRole("log").getByText(attack, { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__demoStorageWrites), 0);
    assert.equal((await context.cookies()).length, 0);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
    record(`${label}: 새로고침 초기화·저장소 쓰기·쿠키 없음`);

    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".skip-link").evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("main").evaluate(element => element === document.activeElement), true);
    if (label === "mobile") {
      const menu = page.getByRole("button", { name: "시나리오 메뉴", exact: true });
      await menu.click(); await page.keyboard.press("Escape");
      assert.equal(await menu.getAttribute("aria-expanded"), "false");
    }
    record(`${label}: 키보드 바로가기·모바일 메뉴 닫기`);
    assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(sensitiveRequests, []);
    record(`${label}: 브라우저 오류·실패 요청·API/외부 통신 없음`);
    await context.close();
  }
  const report = { status: "passed", checks: results.length, scope: "공개 정적 데모: 실제 AI·API·파일 실행 검증이 아님", build, results };
  if (artifacts) await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
