/**
 * Sprint 2 · Step 6 — 전체 제품 시나리오 (자동).
 *
 * Project 생성 → AI 코드 생성 → 테스트 → 실패 → AI 수정 → Git Commit →
 * Memory 저장 → Plugin 호출 → 최종 Build → 최종 Test.
 *
 * Sprint 1과의 결정적 차이: '테스트가 실제로 실패하는 상태'를 만들고, AI가 실패 출력을
 * 읽고 스스로 고치는 루프를 검증한다. 성공 경로만 도는 시나리오는 에이전트의 핵심 역량
 * (실패로부터의 복구)을 전혀 검증하지 못한다.
 */
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { renderTemplate, SYSTEM_CORE_TEMPLATE, evaluateCompletion, type CompletionCheck } from "@aios/ai";
import {
  DEFAULT_POLICY, GitService, ToolExecutor, ToolRegistry,
  listDirTool, readFileTool, writeFileTool,
} from "@aios/tools";
import type { ToolAuditRecord, ToolDefinition } from "@aios/tools";
import type { ChatMessage, ToolCall } from "@aios/shared";
import { Report } from "./report.js";
import { createHarness } from "./harness.js";

const exec = promisify(execFile);
const r = new Report("SPRINT 2 · STEP 6 — Full product scenario");
const h = await createHarness();

const audit: ToolAuditRecord[] = [];
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(listDirTool);

const workdir = await mkdtemp(join(tmpdir(), "aios-s2-"));

/**
 * 프로젝트 테스트 러너를 도구로 노출한다.
 * Docker 샌드박스 대신 호스트에서 node를 직접 돌리는 이유: 이 시나리오의 검증 대상은
 * '에이전트가 실패 출력을 읽고 고치는가'이지 샌드박스 격리가 아니다(그건 Step 5/8이 담당).
 * 실행 범위는 프로젝트 디렉토리로 제한하고 타임아웃을 건다.
 */
const runTestsTool: ToolDefinition = {
  name: "run_tests",
  description: "Run the project's test suite and return the output. Use this to check whether your changes work.",
  permission: "exec",
  schema: z.object({}),
  async handler(ctx) {
    try {
      const { stdout, stderr } = await exec("node", ["--experimental-strip-types", "--no-warnings", "test.ts"], {
        cwd: ctx.projectRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      });
      return `TESTS PASSED\n${stdout}${stderr}`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `TESTS FAILED\n${e.stdout ?? ""}${e.stderr ?? e.message ?? ""}`.slice(0, 4000);
    }
  },
};
registry.register(runTestsTool);

const executor = new ToolExecutor(
  registry,
  { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, exec: "confirm" }, confirm: async () => true, timeoutMs: 60_000 },
  async (rec) => { audit.push(rec); },
);

/** 에이전트 루프 한 세션을 돌리고, 실행된 도구 호출과 최종 텍스트를 돌려준다 */
async function runAgent(
  system: string,
  userMessage: string,
  ctx: { orgId: string; userId?: string; sessionId: string; projectRoot: string },
  maxTurns = 8,
  /**
   * '완료'의 정의. 제품 오케스트레이터와 **같은 게이트 정책**을 쓴다
   * (packages/ai/src/completion-gate.ts) — 여기서 따로 구현하면 반드시 갈라진다.
   */
  completionCheck?: CompletionCheck,
): Promise<{ calls: ToolCall[]; text: string; turns: number; nudges: number; completed: boolean; exhausted: boolean }> {
  const convo: ChatMessage[] = [{ role: "user", content: userMessage }];
  const allCalls: ToolCall[] = [];
  let finalText = "";
  let turns = 0;
  let nudges = 0;

  for (let t = 0; t < maxTurns; t++) {
    const calls: ToolCall[] = [];
    let text = "";
    let stop = "end_turn";
    for await (const ev of h.router.stream(
      { system, messages: convo, tools: registry.specs(), maxTokens: 8000 },
      { taskClass: "code", needTools: true },
    )) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "tool_call") calls.push(ev.call);
      if (ev.type === "done") stop = ev.stopReason;
    }
    convo.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
    finalText = text;
    if (!calls.length || stop !== "tool_use") {
      const gate = await evaluateCompletion({ check: completionCheck, retriesSoFar: nudges });
      if (!gate.proceed) break;
      nudges++;
      convo.push({ role: "user", content: gate.nudge! });
      continue;
    }
    turns++;
    for (const c of calls) {
      allCalls.push(c);
      const res = await executor.execute(ctx, c);
      convo.push({ role: "tool", content: res.output, toolCallId: c.id });
    }
  }
  /*
   * 루프가 **어떤 이유로 끝났든** 완료 여부를 확정한다.
   *
   * 게이트는 "모델이 스스로 멈췄을 때"만 돌았다. 그런데 모델이 maxTurns 를 전부
   * 도구 호출로 소진하면 그 분기를 타지 않고 루프가 조용히 끝난다 —
   * 호출자는 완료된 줄 안다. 실제로 수리가 실패한 실행에서 게이트가 개입한 흔적이
   * 없었고, 이 경로가 유력한 설명이다.
   * 여기서 한 번 더 확인하면 최소한 **완료되지 않았다는 사실**은 드러난다.
   */
  const completed = completionCheck ? await completionCheck().then((v) => v.done).catch(() => true) : true;
  return { calls: allCalls, text: finalText, turns, nudges, completed, exhausted: turns >= maxTurns };
}

try {
  // ---------- 0. 외부 도구 확인 ----------
  /*
   * 이 시나리오는 git 에 의존한다. 없으면 1단계에서 `spawn git ENOENT` 로 죽는데,
   * 그러면 결과가 "Full scenario: FAIL" 로만 보여 **제품이나 모델이 실패한 것처럼 읽힌다.**
   * 실제로 한 번 그랬다 — 원인은 맥의 개발자 도구 경로가 일시적으로 무효해진 것이었다
   * (/usr/bin/git 은 활성 개발자 디렉터리로 넘기는 shim 이다).
   *
   * 환경 문제와 제품 결함은 다른 색이어야 한다. 시작하자마자 확인하고, 없으면
   * 무엇이 없는지 이름을 대며 멈춘다.
   */
  r.section("0 — Toolchain");
  // 오류 메시지의 줄바꿈을 접는다 — 리포트는 한 줄만 보여 주므로,
  // 그대로 두면 뒤에 붙인 조치 안내가 잘려 사라진다(실제로 그랬다).
  const gitVersion = await exec("git", ["--version"])
    .then((x) => x.stdout.trim())
    .catch((e: Error) => `사용 불가: ${e.message.replace(/\s+/g, " ").trim()}`);
  r.check("env.git_available", /^git version/.test(gitVersion),
    gitVersion.startsWith("git version")
      ? gitVersion
      : `${gitVersion} — 제품 결함이 아니라 실행 환경 문제다. macOS 라면 xcode-select --install 후 다시 실행하라.`);
  if (!gitVersion.startsWith("git version")) {
    // 여기서 멈춘다. 계속하면 이후 20개 단언이 전부 같은 원인으로 무너져 원인을 가린다.
    r.finish();
    process.exit(1);
  }

  // ---------- 1. Project 생성 ----------
  r.section("1 — Project created");
  await exec("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  await exec("git", ["config", "user.email", "s2@aios.local"], { cwd: workdir });
  await exec("git", ["config", "user.name", "s2"], { cwd: workdir });

  // 스펙과 테스트를 먼저 둔다 — 테스트가 요구사항의 실행 가능한 표현이다.
  await writeFile(join(workdir, "README.md"), "# Invoice utils\n\nPricing helpers for invoices.\n");
  await writeFile(join(workdir, "test.ts"),
    [
      'import { applyTax, lineTotal, invoiceTotal } from "./src/invoice.ts";',
      "",
      "function assertEq(actual: number, expected: number, label: string): void {",
      "  const ok = Math.abs(actual - expected) < 1e-9;",
      '  console.log(`${ok ? "ok" : "FAIL"} ${label}: got ${actual}, want ${expected}`);',
      "  if (!ok) process.exitCode = 1;",
      "}",
      "",
      'assertEq(lineTotal({ price: 10, qty: 3 }), 30, "lineTotal 10x3");',
      'assertEq(applyTax(100, 0.1), 110, "applyTax 100 @10%");',
      'assertEq(applyTax(0, 0.2), 0, "applyTax zero base");',
      'assertEq(invoiceTotal([{ price: 10, qty: 2 }, { price: 5, qty: 4 }], 0.1), 44, "invoiceTotal with tax");',
      'assertEq(invoiceTotal([], 0.1), 0, "invoiceTotal empty");',
      "",
      'if (process.exitCode === 1) { console.log("SUITE FAILED"); } else { console.log("SUITE PASSED"); }',
    ].join("\n"));
  await exec("git", ["add", "-A"], { cwd: workdir });
  await exec("git", ["commit", "-q", "-m", "spec: invoice test suite"], { cwd: workdir });

  const { rows: pr } = await h.pool.query<{ id: string }>(
    `insert into projects (org_id, name) values ($1,'invoice-utils') returning id`, [h.orgId]);
  const projectId = pr[0]!.id;
  const sessionId = randomUUID();
  await h.pool.query(
    `insert into sessions (id, org_id, project_id, user_id, title) values ($1,$2,$3,$4,'s2-scenario')`,
    [sessionId, h.orgId, projectId, h.userId]);
  const toolCtx = { orgId: h.orgId, userId: h.userId, sessionId, projectRoot: workdir };
  const system = renderTemplate(SYSTEM_CORE_TEMPLATE, { projectName: "invoice-utils", workdir });

  r.check("s1.project_ready", !!projectId, `project ${projectId.slice(0, 8)}, git repo at ${workdir}`);

  // ---------- 2. AI 코드 생성 (의도적으로 불완전한 명세) ----------
  r.section("2 — AI writes the implementation");
  // 세율 적용만 언급하고 '빈 배열'과 '합계에 세금 적용' 같은 경계는 일부러 말하지 않는다.
  // 이렇게 해야 테스트가 실제로 실패할 여지가 생기고, 6단계(자가 수정)를 검증할 수 있다.
  const gen = await runAgent(system,
    "Create src/invoice.ts exporting three named functions: " +
    "`lineTotal(item: {price: number; qty: number}): number`, " +
    "`applyTax(amount: number, rate: number): number`, and " +
    "`invoiceTotal(items: {price: number; qty: number}[], taxRate: number): number`. " +
    "Use write_file. Do NOT run the tests yet — just write the file and stop.",
    toolCtx, 5);

  /*
   * 생성 에이전트가 돈 직후 저장소가 온전한지 확인한다.
   *
   * 왜: 한 번 `git add -A` 가 `fatal: not a git repository` 로 죽었는데,
   * 그때는 **언제 .git 이 사라졌는지** 알 수 없어 원인을 좁히지 못했다.
   * 여기서 끊어 두면 다음에는 "에이전트가 돈 뒤"인지 "그 전"인지 바로 갈린다.
   * (도구 감옥에 .git 차단을 넣었지만, 그것이 원인이었다고 확인하지는 못했다.)
   */
  const repoIntact = await exec("git", ["rev-parse", "--git-dir"], { cwd: workdir })
    .then(() => true).catch(() => false);
  r.check("s2.repo_intact_after_agent", repoIntact,
    repoIntact ? "에이전트가 돈 뒤에도 git 저장소가 온전하다" : "에이전트 실행 중 .git 이 손상됐다");

  const implPath = join(workdir, "src/invoice.ts");
  const impl = await readFile(implPath, "utf8").catch(() => "");
  r.check("s2.file_written", impl.length > 0, `${impl.length} bytes at src/invoice.ts after ${gen.turns} tool turns`);
  r.check("s2.exports_all_three",
    /export\s+(function|const)\s+lineTotal/.test(impl) &&
    /export\s+(function|const)\s+applyTax/.test(impl) &&
    /export\s+(function|const)\s+invoiceTotal/.test(impl),
    `exports found: ${["lineTotal", "applyTax", "invoiceTotal"].filter((n) => new RegExp(`export\\s+(function|const)\\s+${n}`).test(impl)).join(", ")}`);

  // ---------- 3. 테스트 실행 → 실패 상태를 확보 ----------
  r.section("3 — Tests run (failure injected)");
  // 자가 수정 루프를 '반드시' 검증하기 위해, 통과했든 아니든 결함을 주입해 실패를 확정한다.
  // 모델이 우연히 처음부터 맞히면 4단계가 검증되지 않기 때문 — 검증은 운에 기대면 안 된다.
  const broken = impl.replace(
    /export\s+function\s+lineTotal\s*\(([^)]*)\)\s*:\s*number\s*\{[\s\S]*?\n\}/,
    (m) => m.replace(/\bprice\s*\*\s*qty\b|\bqty\s*\*\s*price\b|item\.price\s*\*\s*item\.qty|item\.qty\s*\*\s*item\.price/g, "item.price + item.qty"),
  );
  const injected = broken !== impl;
  await writeFile(implPath, injected ? broken : impl.replace(/\*/, "+")); // 곱셈 하나를 덧셈으로
  await exec("git", ["add", "-A"], { cwd: workdir });
  await exec("git", ["commit", "-q", "-m", "impl: initial (contains a defect)"], { cwd: workdir });

  const firstRun = await executor.execute(toolCtx, { id: "t_run1", name: "run_tests", arguments: {} });
  const failedInitially = firstRun.output.includes("TESTS FAILED") || firstRun.output.includes("FAIL ");
  r.check("s3.tests_actually_fail", failedInitially,
    `defect injected (${injected ? "targeted" : "fallback"}); runner says: ${firstRun.output.split("\n").slice(0, 3).join(" | ").slice(0, 130)}`);

  // ---------- 4. AI가 실패를 읽고 수정 ----------
  r.section("4 — AI reads the failure and repairs");
  const fix = await runAgent(system,
    "The test suite is failing. Use run_tests to see the failures, read src/invoice.ts, " +
    "then use write_file to fix the implementation so every assertion passes. " +
    "Re-run run_tests to confirm. Do not modify test.ts.",
    toolCtx, 10,
    /*
     * 이 작업의 '완료' 는 "테스트가 통과한다" 이다.
     * 모델이 고치겠다고 설명만 하고 끝내는 일이 반복됐고 프롬프트로는 막지 못했다 —
     * 판정을 시스템이 한다. 이 게이트는 제품 오케스트레이터가 쓰는 것과 같은 정책이다.
     */
    async () => {
      const run = await executor.execute(toolCtx, { id: `t_gate_${Date.now()}`, name: "run_tests", arguments: {} });
      const passed = run.output.includes("SUITE PASSED") && !run.output.includes("FAIL ");
      return { done: passed, reason: run.output.slice(0, 1_500) };
    });

  const usedRunTests = fix.calls.some((c) => c.name === "run_tests");
  const usedRead = fix.calls.some((c) => c.name === "read_file");
  const usedWrite = fix.calls.some((c) => c.name === "write_file");
  r.check("s4.agent_investigated", usedRunTests && usedRead,
    `tool sequence: ${fix.calls.map((c) => c.name).join(" → ")}` +
    // 게이트가 몇 번 개입했는지 항상 남긴다 — 통과했을 때 그것이 모델 덕인지
    // 게이트 덕인지 구분할 수 없으면 다음에 또 같은 판단을 못 한다.
    (fix.nudges > 0 ? ` (완료 게이트 개입 ${fix.nudges}회)` : " (게이트 개입 없음)"));
  /*
   * 실패했을 때 "0번 불렀다"만 남기면 원인을 알 수 없다 — 모델이 무엇을 했는지가 빠진다.
   * 실제로 한 번 실패했을 때 그랬다: 도구를 안 불렀다는 사실만 알고, 대신 무슨 말을 했는지,
   * 몇 턴을 돌았는지는 알 수 없어 재현 말고는 방법이 없었다.
   * 로컬 모델은 같은 입력에도 다르게 행동하므로 **그 순간의 증거**를 남겨 두어야 한다.
   */
  const writeCount = fix.calls.filter((c) => c.name === "write_file").length;
  r.check("s4.agent_edited", usedWrite,
    usedWrite
      ? `write_file called ${writeCount} time(s)`
      : `write_file called 0 time(s) — ${fix.turns}턴, 도구 [${fix.calls.map((c) => c.name).join(", ") || "없음"}], ` +
        `모델의 마지막 응답: "${fix.text.replace(/\s+/g, " ").trim().slice(0, 200)}"`);

  // 테스트 파일을 고쳐서 통과시키는 부정행위를 하지 않았는가 — 중요한 검증
  const { stdout: testDiff } = await exec("git", ["diff", "--", "test.ts"], { cwd: workdir });
  r.check("s4.did_not_edit_tests", testDiff.trim() === "",
    testDiff.trim() === "" ? "test.ts untouched — the fix is in the implementation, not the spec" : "AGENT MODIFIED THE TESTS");

  // ---------- 5. 최종 테스트 (독립 실행) ----------
  r.section("5 — Independent verification");
  const finalRun = await executor.execute(toolCtx, { id: "t_run2", name: "run_tests", arguments: {} });
  const passes = finalRun.output.includes("SUITE PASSED") && !finalRun.output.includes("FAIL ");
  const testTail = finalRun.output.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 160);
  /*
   * 실패하면 **모델이 실제로 무엇을 썼는지** 함께 남긴다.
   * "got 84, want 44" 만으로는 왜 틀렸는지 알 수 없고, 이 실패는 재현되지 않는 종류라
   * (로컬 모델은 같은 입력에도 다르게 답한다) 그 순간의 코드를 남기지 않으면 영영 못 본다.
   * 실제로 그래서 한 번 판단을 미뤄야 했다.
   */
  const writtenImpl = await readFile(implPath, "utf8").catch(() => "(읽을 수 없음)");
  r.check("s5.suite_passes_after_repair", passes,
    passes
      ? testTail
      : `${testTail} — ${fix.turns}턴/최대10${fix.exhausted ? "(소진)" : ""}, 게이트 개입 ${fix.nudges}회, ` +
        `루프 종료 시 완료판정=${fix.completed} — 에이전트가 쓴 구현: ` +
        `${writtenImpl.replace(/\s+/g, " ").trim().slice(0, 350)}`);

  const finalImpl = await readFile(implPath, "utf8");
  r.check("s5.implementation_changed", finalImpl !== (injected ? broken : impl),
    `implementation is ${finalImpl.length} bytes after repair`);

  // ---------- 6. Git Commit ----------
  r.section("6 — Git checkpoint");
  const git = new GitService(workdir);
  const commit = await git.autoCommit("fix invoice calculations so the suite passes");
  r.check("s6.commit_created", !!commit?.sha, `sha=${commit?.sha}`);
  const { stdout: log } = await exec("git", ["log", "--oneline"], { cwd: workdir });
  r.check("s6.history_intact", log.split("\n").filter(Boolean).length >= 3,
    log.trim().split("\n").map((l) => l.slice(0, 42)).join(" / "));
  const { stdout: status } = await exec("git", ["status", "--porcelain"], { cwd: workdir });
  r.check("s6.tree_clean_after_commit", status.trim() === "", "working tree clean — nothing left uncommitted");

  // ---------- 7. Memory 저장 ----------
  r.section("7 — Memory persisted");
  const stored = await h.memory.extractAndStore(
    { orgId: h.orgId, userId: h.userId, projectId }, sessionId,
    [
      { role: "user", content: "In this project, invoice totals always apply tax to the summed line totals, never per line." },
      { role: "assistant", content: "Understood — tax is applied once to the subtotal in invoice-utils." },
    ]);
  r.check("s7.facts_extracted", stored > 0, `${stored} fact(s) written to long-term memory`);
  const recalled = await h.memory.ltm.recall({ orgId: h.orgId, userId: h.userId, projectId }, "how is tax applied to invoices?", 5);
  r.check("s7.recallable", recalled.some((m) => /tax/i.test(m.content)),
    recalled.map((m) => m.content.slice(0, 50)).join(" | ") || "(nothing recalled)");

  // ---------- 8. Plugin 호출 ----------
  r.section("8 — Plugin invoked");
  await r.guard("s8.plugin", async () => {
    const { loadPlugin, parseManifest } = await import("@aios/plugin-host");
    const pdir = join(workdir, ".aios");
    await mkdir(pdir, { recursive: true });
    const bundle = `
import { parentPort } from "node:worker_threads";
let seq = 0; const pending = new Map();
function rpc(m, p) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, {res, rej}); parentPort.postMessage({ id, method: m, params: p }); }); }
const handlers = {
  async count_exports(args) {
    const n = (String(args.source ?? "").match(/export\\s+(function|const)\\s+/g) || []).length;
    return "exports=" + n;
  },
};
parentPort.on("message", async (msg) => {
  if (msg.method === "tool.invoke") {
    try { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, output: await handlers[msg.params.name](msg.params.args) } }); }
    catch (e) { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, error: String(e) } }); }
    return;
  }
  const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error)) : p.res(msg.result); }
});
await rpc("tools.register", { name: "count_exports", description: "count exported declarations in the given source" });
`;
    const bp = join(pdir, "index.mjs");
    await writeFile(bp, bundle);
    const manifest = parseManifest({
      name: "export-counter", version: "1.0.0", displayName: "Export Counter", entry: "index.js",
      engines: { aios: ">=0.1.0" }, permissions: ["tools.register"],
      contributes: { tools: [{ name: "count_exports", description: "count exports" }] },
    });
    const loaded = await loadPlugin(bp, manifest, createHash("sha256").update(await readFile(bp)).digest("hex"), null, {
      registry, granted: ["tools.register"], kv: { get: async () => null, set: async () => {} },
    });
    await new Promise((res) => setTimeout(res, 800));

    const pluginExe = new ToolExecutor(registry,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, net: "confirm" }, confirm: async () => true },
      async (rec) => { audit.push(rec); });
    const res = await pluginExe.execute(toolCtx,
      { id: "p1", name: "plugin__export-counter__count_exports", arguments: { source: finalImpl } });
    const expected = (finalImpl.match(/export\s+(function|const)\s+/g) ?? []).length;
    r.check("s8.plugin_executed", res.ok && res.output === `exports=${expected}`,
      `${res.output} (expected exports=${expected})`);
    await loaded.stop();
  });

  // ---------- 9. 최종 Build ----------
  r.section("9 — Final build");
  await r.guard("s9.build", async () => {
    // 타입 검사를 빌드로 삼는다 — 실행되는 코드가 타입 계약을 지키는지 확인.
    // 임시 프로젝트에는 node_modules가 없으므로 저장소의 @types/node를 typeRoots로 빌려준다.
    // (이걸 빼면 test.ts의 `process` 참조가 미해결로 잡혀, AI 코드가 아니라 하네스 때문에 실패한다 —
    //  실제로 겪은 오판이다.)
    const repoRoot = process.cwd().replace(/\/apps\/verify$/, "");
    await writeFile(join(workdir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true,
        types: ["node"],
        typeRoots: [join(repoRoot, "node_modules", "@types")],
      },
      include: ["src", "test.ts"],
    }, null, 2));
    const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
    let buildOut = "";
    let buildOk = true;
    try {
      const { stdout, stderr } = await exec(tsc, ["--noEmit", "-p", "tsconfig.json"], { cwd: workdir, timeout: 120_000 });
      buildOut = `${stdout}${stderr}`;
    } catch (err) {
      buildOk = false;
      const e = err as { stdout?: string; stderr?: string; message?: string };
      buildOut = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`.slice(0, 800);
    }
    r.check("s9.typechecks", buildOk,
      buildOk
        ? "tsc --noEmit clean across the AI-generated implementation and the spec"
        : (buildOut.split("\n").filter(Boolean).slice(0, 3).join(" | ") || "tsc failed with no output"));
  });

  // ---------- 10. 최종 Test (빌드 후 재실행) ----------
  r.section("10 — Final test after build");
  const lastRun = await executor.execute(toolCtx, { id: "t_run3", name: "run_tests", arguments: {} });
  r.check("s10.final_suite_passes", lastRun.output.includes("SUITE PASSED"),
    lastRun.output.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 140));

  // ---------- 파이프라인 사후 조건 ----------
  r.section("Pipeline post-conditions");
  {
    const toolNames = [...new Set(audit.map((a) => a.toolName))];
    r.check("pipeline.all_tool_kinds_exercised",
      ["read_file", "write_file", "run_tests"].every((n) => toolNames.includes(n)) &&
      toolNames.some((n) => n.startsWith("plugin__")),
      `tools used: ${toolNames.join(", ")}`);
    r.check("pipeline.audit_complete", audit.every((a) => a.sessionId === sessionId && typeof a.durationMs === "number"),
      `${audit.length} invocations, all bound to session ${sessionId.slice(0, 8)}`);
    // 도구 오류를 두 종류로 나눈다.
    //  - 탐색 실패(없는 경로 read/list): 에이전트가 결과를 보고 다음 수를 두는 정상 흐름이다.
    //    소프트 에러로 돌려주는 것이 설계 의도이고, 실제로 여기서 복구해 최종 통과했다.
    //  - 인프라 실패(timeout, 샌드박스/플러그인 크래시): 복구 여지가 없는 문제.
    // 전자를 실패로 세면 "에이전트가 탐색을 시도했다"는 이유로 파이프라인이 빨개진다.
    const timeouts = audit.filter((a) => a.status === "timeout");
    const softErrors = audit.filter((a) => a.status === "error");
    const recoverable = new Set(["read_file", "list_dir", "run_tests"]);
    const hardErrors = softErrors.filter((a) => !recoverable.has(a.toolName));

    r.check("pipeline.no_infrastructure_failures", timeouts.length === 0 && hardErrors.length === 0,
      `${timeouts.length} timeouts, ${hardErrors.length} unrecoverable tool errors` +
      (softErrors.length ? `; ${softErrors.length} recoverable exploration miss(es): ${softErrors.map((f) => f.toolName).join(", ")}` : ""));
    r.check("pipeline.recovered_from_tool_errors", lastRun.output.includes("SUITE PASSED"),
      softErrors.length === 0
        ? "no tool errors occurred"
        : `the agent hit ${softErrors.length} soft tool error(s) and still converged on a passing suite`);
    const { rows: msgs } = await h.pool.query<{ n: string }>(
      `select count(*)::text as n from tool_invocations where session_id = $1`, [sessionId]);
    console.log(`    (in-memory audit: ${audit.length}; note tool_invocations table is written by the API server, not this harness — ${msgs[0]!.n} rows)`);
  }
} catch (err) {
  await r.guard("s2-scenario.uncaught", () => Promise.reject(err instanceof Error ? err : new Error(String(err))));
} finally {
  await h.close();
}

r.finish();
