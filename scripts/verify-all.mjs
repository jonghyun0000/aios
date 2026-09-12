#!/usr/bin/env node
/**
 * 전체 검증 오케스트레이터.
 *
 * 각 단계를 실제로 실행하고 PASS/FAIL을 집계한다. 어느 하나라도 실패하면 exit 1.
 * 프로바이더 키가 없는 단계는 SKIP으로 표시하되, SKIP을 PASS로 세지 않는다 —
 * "검증하지 않았다"와 "검증했고 통과했다"를 섞으면 보고서가 거짓말이 된다.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  { id: "typecheck", label: "Type check", cmd: "pnpm", args: ["-r", "--no-bail", "exec", "tsc", "--noEmit"] },
  { id: "lint", label: "Lint", cmd: "pnpm", args: ["exec", "eslint", ".", "--max-warnings=0"] },
  { id: "unit", label: "Unit tests", cmd: "pnpm", args: ["-r", "--no-bail", "exec", "vitest", "run", "--passWithNoTests"] },
  { id: "local-ops", label: "Local operations fault injection", cmd: "node", args: ["--test", "scripts/local-backup.test.mjs", "scripts/local-lifecycle.test.mjs", "scripts/package-local.test.mjs"] },
  { id: "build", label: "Build", cmd: "pnpm", args: ["build"] },
  { id: "s2-claude", label: "Claude live", cmd: "pnpm", args: ["--filter", "@aios/verify", "s2:claude"], needsKey: "anthropic" },
  // 누수 측정은 강제 GC가 있어야 성립한다. NODE_OPTIONS로 주는 이유: tsx가 자식 프로세스를
  // 띄우므로 `node --expose-gc tsx ...` 형태로는 플래그가 실제 실행 프로세스에 닿지 않는다.
  { id: "s2-memory", label: "Memory stress", cmd: "pnpm", args: ["--filter", "@aios/verify", "s2:memory"],
    env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`.trim() } },
  { id: "phase3", label: "Router", cmd: "pnpm", args: ["--filter", "@aios/verify", "phase3"], needsKey: true },
  { id: "phase4", label: "Tools", cmd: "pnpm", args: ["--filter", "@aios/verify", "phase4"] },
  { id: "s2-scenario", label: "Full scenario", cmd: "pnpm", args: ["--filter", "@aios/verify", "s2:scenario"], needsKey: true },
  // Sprint #3 — 협업/마켓플레이스/결제/OAuth. 앞의 세 개는 실행 중인 API 서버가 필요하고
  // (AIOS_BASE_URL + AIOS_API_KEY), billing/oauth는 목 서버를 스스로 띄우므로
  // Stripe/GitHub 계정 없이도 돈다.
  { id: "s3-collab", label: "Collaboration", cmd: "pnpm", args: ["--filter", "@aios/verify", "s3:collab"], needsServer: true },
  { id: "s3-marketplace", label: "Marketplace", cmd: "pnpm", args: ["--filter", "@aios/verify", "s3:marketplace"], needsServer: true },
  { id: "s3-billing", label: "Billing", cmd: "pnpm", args: ["--filter", "@aios/verify", "s3:billing"], needsServer: true },
  { id: "s3-oauth", label: "OAuth", cmd: "pnpm", args: ["--filter", "@aios/verify", "s3:oauth"] },
  { id: "s3-webui", label: "Web UI", cmd: "pnpm", args: ["--filter", "@aios/verify", "s3:webui"], needsServer: true },
  // 공공통계 데이터 계층. DuckDB 파일은 읽기 전용 연결도 락을 잡으므로
  // API 서버가 떠 있으면 실패한다 — needsServer를 붙이지 않는 이유가 그것이다.
  { id: "s4-bigdata", label: "BigData tools", cmd: "pnpm", args: ["--filter", "@aios/verify", "s4:bigdata"], needsBigData: true },
  // HTTP 라우트 검증은 서버가 **떠 있어야** 한다. s4와 배타적이다 —
  // s4는 DuckDB를 직접 열고, DuckDB는 읽기 전용 연결도 파일 락을 잡는다.
  { id: "s5-bigdata-api", label: "BigData API", cmd: "pnpm", args: ["--filter", "@aios/verify", "s5:bigdata-api"], needsServer: true },
  // 자체적으로 API 인스턴스 2개를 띄운다. 기존 서버와 포트가 겹치지 않으므로
  // needsServer 가 아니라 키만 있으면 된다.
  { id: "s6-collab-multi", label: "Collab multi-node", cmd: "pnpm", args: ["--filter", "@aios/verify", "s6:collab-multi"], needsServer: true },
  // 브라우저 자동 회귀. 실제 Chromium 으로 UI를 조작한다.
  // 브라우저 바이너리는 T7에 있다(Mac 내장 디스크는 여유가 없다).
  { id: "e2e", label: "Browser E2E", cmd: "pnpm", args: ["--filter", "@aios/web", "test:e2e"],
    needsServer: true,
    env: { PLAYWRIGHT_BROWSERS_PATH: "/Volumes/T7/bigdata/playwright-browsers" } },
  { id: "phase6", label: "Performance", cmd: "pnpm", args: ["--filter", "@aios/verify", "phase6"] },
  { id: "phase7", label: "Security", cmd: "pnpm", args: ["--filter", "@aios/verify", "phase7"] },
  { id: "phase8", label: "Production", cmd: "pnpm", args: ["--filter", "@aios/verify", "phase8"] },
];

const only = process.argv.slice(2);
/*
 * 프로바이더 가용성.
 *
 * `needsKey: true` = 프로바이더가 아무거나 하나 있으면 되는 단계. 로컬 추론 서버도
 * 프로바이더이므로 여기 포함한다 — 빼 두면 외부 키 없이 도는 구성에서 라우터 검증이
 * 통째로 SKIP 되고, 그 SKIP 이 "검증됨"으로 오해된다.
 *
 * `needsKey: "anthropic"` = **그 프로바이더가 아니면 성립하지 않는** 단계.
 * s2-claude 는 claude-sonnet-5 의 실제 동작(사고 토큰, 모델별 오류 형태)을 재는 것이라
 * 로컬 모델로 대체할 수 없다. 이걸 구분하지 않으면 "돌 수 없는 검증"이
 * 실패로 기록되어 진짜 결함과 섞인다.
 */
const anyProvider = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY ||
  process.env.XAI_API_KEY || process.env.LOCAL_LLM_BASE_URL,
);
const providerKeys = {
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  openai: Boolean(process.env.OPENAI_API_KEY),
  gemini: Boolean(process.env.GEMINI_API_KEY),
  xai: Boolean(process.env.XAI_API_KEY),
};
const hasProviderFor = (need) => (typeof need === "string" ? providerKeys[need] === true : anyProvider);
// 실행 중인 API 서버가 필요한 단계는 주소와 키가 둘 다 있어야 의미가 있다.
// 없으면 SKIP으로 표시한다 — 서버가 없어서 실패한 것을 제품 결함으로 기록하면 안 된다.
const hasServer = Boolean(process.env.AIOS_BASE_URL && process.env.AIOS_API_KEY);

/**
 * pnpm 실행 파일 해석.
 * PATH에 pnpm이 없는 환경(corepack 미활성, CI 러너 등)이 흔하므로, 워크스페이스에
 * 설치된 바이너리를 먼저 찾고 없으면 PATH의 pnpm에 맡긴다.
 */
const LOCAL_PNPM = join(repo, "node_modules", ".bin", "pnpm");
const PNPM = existsSync(LOCAL_PNPM) ? LOCAL_PNPM : "pnpm";

function run(step) {
  return new Promise((res) => {
    const t0 = Date.now();
    const cmd = step.cmd === "pnpm" ? PNPM : step.cmd;
    const child = spawn(cmd, step.args, {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(step.env ?? {}) },
      shell: process.platform === "win32",
    });
    child.on("error", (err) => res({ code: 1, ms: Date.now() - t0, tail: [`spawn failed: ${err.message}`] }));
    let tail = [];
    const capture = (buf) => {
      tail.push(...String(buf).split("\n").filter(Boolean));
      if (tail.length > 40) tail = tail.slice(-40);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("close", (code) => res({ code, ms: Date.now() - t0, tail }));
  });
}

const results = [];
for (const step of STEPS) {
  if (only.length && !only.includes(step.id)) continue;
  if (step.needsKey && !hasProviderFor(step.needsKey)) {
    const why = typeof step.needsKey === "string"
      ? `${step.needsKey.toUpperCase()}_API_KEY 가 없다 — 이 단계는 해당 프로바이더 고유 동작을 재므로 대체 불가`
      : "프로바이더가 하나도 설정되지 않았다";
    console.log(`SKIP  ${step.label} — ${why}`);
    results.push({ ...step, status: "SKIP" });
    continue;
  }
  if (step.needsBigData && !process.env.BIGDATA_DB_PATH) {
    console.log(`SKIP  ${step.label} — set BIGDATA_DB_PATH (DuckDB dataset required)`);
    results.push({ ...step, status: "SKIP" });
    continue;
  }
  if (step.needsServer && !hasServer) {
    console.log(`SKIP  ${step.label} — set AIOS_BASE_URL and AIOS_API_KEY (running API server required)`);
    results.push({ ...step, status: "SKIP" });
    continue;
  }
  /*
   * 서버가 살아 있는지 단계 직전에 확인한다.
   *
   * 왜: API 서버가 실행 도중 죽는 일이 실제로 두 번 있었다(네이티브 SIGBUS — 잡을 수 없다).
   * 그러면 이후 서버 의존 단계들이 전부 `fetch failed` 수십 줄로 실패하고,
   * 진짜 원인("서버가 이미 죽어 있었다")은 그 잡음에 묻힌다.
   * 죽었으면 여기서 한 줄로 말하고, 어느 단계 다음에 죽었는지도 남긴다.
   */
  if (step.needsServer) {
    const alive = await fetch(new URL("/healthz", process.env.AIOS_BASE_URL), {
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.ok).catch(() => false);
    if (!alive) {
      const after = results.filter((r) => r.status === "PASS").pop();
      console.log(
        `BLOCKED ${step.label} — API 서버가 응답하지 않는다(${process.env.AIOS_BASE_URL}). ` +
        `마지막 성공 단계: ${after ? after.label : "없음"}. ` +
        `프로세스가 죽었다면 ~/Library/Logs/DiagnosticReports 의 node-*.ips 를 확인하라.`,
      );
      results.push({ ...step, status: "BLOCKED", blockReason: "API 서버 무응답" });
      continue;
    }
  }
  process.stdout.write(`RUN   ${step.label} ... `);
  const { code, ms, tail } = await run(step);
  // exit 2 = 프로바이더 계정 문제로 검증을 수행할 수 없었다는 신호(제품 실패 아님).
  const status = code === 0 ? "PASS" : code === 2 && step.needsKey ? "BLOCKED" : "FAIL";
  console.log(`${status} (${(ms / 1000).toFixed(1)}s)`);
  if (status === "FAIL") for (const l of tail.slice(-12)) console.log(`        ${l}`);
  if (status === "BLOCKED") console.log(`        ${tail.filter((l) => /BLOCKED|credit|quota|billing/i.test(l)).slice(-2).join(" | ") || "provider account issue"}`);
  results.push({ ...step, status, ms });
}

const failed = results.filter((x) => x.status === "FAIL");
const skipped = results.filter((x) => x.status === "SKIP");
const blocked = results.filter((x) => x.status === "BLOCKED");
const passed = results.filter((x) => x.status === "PASS");

console.log(`\n${"=".repeat(64)}`);
const verdict = failed.length > 0 ? "FAIL" : blocked.length > 0 ? "BLOCKED" : "PASS";
console.log(`VERIFY: ${verdict} — ${passed.length} passed, ${failed.length} failed, ${blocked.length} blocked, ${skipped.length} skipped`);
// 차단 사유는 단계마다 다르다. 하나로 뭉뚱그리면 틀린 진단이 되고,
// 틀린 진단은 없는 진단보다 나쁘다 — 엉뚱한 곳을 파게 만든다.
if (blocked.length) {
  console.log(`blocked (not verified, not a product defect): ${blocked
    .map((b) => `${b.label}${b.blockReason ? ` — ${b.blockReason}` : " — provider account issue"}`)
    .join(", ")}`);
}
if (skipped.length) console.log(`skipped (not verified, not counted as passing): ${skipped.map((s) => s.label).join(", ")}`);
if (failed.length) console.log(`failed: ${failed.map((f) => f.label).join(", ")}`);
console.log("=".repeat(64));
process.exit(failed.length > 0 ? 1 : blocked.length > 0 ? 2 : 0);
