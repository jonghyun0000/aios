import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

const id = "backup-20260912T010203Z-1234abcd";
const time = "2026-01-01T01:02:03.000Z";
const base = { version: 1, mode: "local-read-only", observedAt: time, backupRoot: "/Volumes/T7/bigdata/backups/local" };

test("운영 화면의 미실행·검사 당시 결과·좁은 화면을 확인한다", async ({ page }) => {
  let populated = false;
  await page.route("**/v1/local/operations", (route) => route.fulfill({ json: { ...base, history: populated ? {
    state: "recorded", lastBackup: { id, createdAt: time, bytes: 1234 }, lastRestoreCheck: { backupId: id, checkedAt: time, status: "passed", restoredDatabase: "aios_restore_check_1234abcd", files: 5 },
  } : { state: "empty" } } }));
  await login(page); await goRoute(page, "/settings");
  const panel = page.getByRole("region", { name: "내 컴퓨터 운영" });
  await expect(panel.getByText("아직 백업을 하지 않았습니다.", { exact: true })).toBeVisible();
  await expect(panel.getByText("아직 복원 검사를 하지 않았습니다.", { exact: true })).toBeVisible();
  for (const action of ["시작", "종료", "상태 확인", "백업", "복원 검사"]) await expect(panel.getByText(`AIOS ${action}.command`, { exact: true })).toBeVisible();
  await expect(panel).toContainText("기존 DB와 작업 폴더는 덮어쓰지 않습니다");
  populated = true; await panel.getByRole("button", { name: "운영 기록 새로고침" }).click();
  await expect(panel.getByText("검사 당시 통과", { exact: true })).toBeVisible();
  await expect(panel).toContainText("5개"); await expect(panel).toContainText("지금 백업이 온전하거나 앱이 정상이라는 보장은 아닙니다");
  expect(await panel.getByRole("button").count()).toBe(1);
  const bounds = await panel.evaluate((el) => ({ overflow: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right, viewport: innerWidth }));
  expect(bounds.overflow).toBeLessThanOrEqual(1); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
});

test("고의 손상 기록·통신 실패·누락된 검증 정보를 통과로 표시하지 않는다", async ({ page }) => {
  let fault = "invalid";
  await page.route("**/v1/local/operations", (route) => {
    if (fault === "network") return route.fulfill({ status: 503, json: { error: { message: "고의 운영 기록 조회 실패" } } });
    if (fault === "missing") return route.fulfill({ json: { ...base, history: { state: "recorded", lastRestoreCheck: { backupId: id, checkedAt: time, status: "passed" } } } });
    if (fault === "failed") return route.fulfill({ json: { ...base, history: { state: "recorded", lastRestoreCheck: { backupId: id, checkedAt: time, status: "failed" } } } });
    return route.fulfill({ json: { ...base, history: { state: "invalid", message: "운영 기록 JSON 손상" } } });
  });
  await login(page); await goRoute(page, "/settings");
  const panel = page.getByRole("region", { name: "내 컴퓨터 운영" });
  await expect(panel.getByRole("alert")).toContainText("운영 기록 JSON 손상");
  await expect(panel.getByText("검사 당시 통과", { exact: true })).toHaveCount(0);
  fault = "network"; await panel.getByRole("button", { name: "운영 기록 새로고침" }).click();
  await expect(panel.getByRole("alert")).toContainText("고의 운영 기록 조회 실패");
  fault = "missing"; await panel.getByRole("button", { name: "운영 기록 새로고침" }).click();
  await expect(panel.getByRole("alert")).toContainText("필수 검증 정보");
  await expect(panel.getByText("검사 당시 통과", { exact: true })).toHaveCount(0);
  fault = "failed"; await panel.getByRole("button", { name: "운영 기록 새로고침" }).click();
  await expect(panel.getByText("검사 실패 — 복원 가능 여부 확인 필요", { exact: true })).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
