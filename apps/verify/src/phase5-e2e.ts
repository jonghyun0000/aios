/**
 * Phase 5 — 실전 E2E 시나리오.
 *
 * 프로젝트 생성 → AI 코드 생성 → Git 커밋 → 파일 수정 → Memory 저장 → Tool 호출
 * → Plugin 호출 → 최종 코드 생성까지, 실제 LLM/DB/Redis/도구로 한 번에 관통한다.
 *
 * 각 단계는 '사후 상태'로 검증한다 — LLM이 뭐라고 말했는지가 아니라
 * 파일이 실제로 존재하는지, 커밋이 실제로 생겼는지, DB에 행이 실제로 들어갔는지.
 */
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assemblePrompt, renderTemplate, SYSTEM_CORE_TEMPLATE } from "@aios/ai";
import { CodeRetriever, Indexer } from "@aios/indexer";
import {
  DEFAULT_POLICY, GitService, ToolExecutor, ToolRegistry,
  listDirTool, readFileTool, writeFileTool,
} from "@aios/tools";
import type { ToolAuditRecord } from "@aios/tools";
import type { ChatMessage, ToolCall } from "@aios/shared";
import { Report } from "./report.js";
import { createHarness, hashEmbedder } from "./harness.js";
import { TempWorkspaceRegistry } from "./temp-workspaces.js";

const exec = promisify(execFile);
const r = new Report("PHASE 5 — End-to-end scenario");
const h = await createHarness();

const audit: ToolAuditRecord[] = [];
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(listDirTool);
const executor = new ToolExecutor(registry, DEFAULT_POLICY, async (rec) => { audit.push(rec); });


/*
 * 검증이 만든 임시 디렉터리를 등록해 두고 종료할 때 지운다.
 *
 * 실측: 정리하지 않은 채 반복 실행해 63개가 쌓여 있었다. 개당 240KB 라 당장은 작지만,
 * 사용자의 제약이 "산출물은 T7 에만, 맥에는 두지 않는다" 이고 tmpdir 은 맥 APFS 다.
 * 검증이 자기 흔적을 남기지 않는 것이 기본이다.
 */
const tempWorkspaces = new TempWorkspaceRegistry();
async function tempDir(prefix: string): Promise<string> {
  return tempWorkspaces.create(prefix);
}
async function cleanupTempDirs(): Promise<void> {
  await tempWorkspaces.cleanup();
}

try {
  // ---------- Step 1: 프로젝트 생성 ----------
  r.section("Step 1 — Project created");
  const workdir = await tempDir("aios-e2e-");
  await exec("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  await exec("git", ["config", "user.email", "e2e@aios.local"], { cwd: workdir });
  await exec("git", ["config", "user.name", "e2e"], { cwd: workdir });
  await writeFile(join(workdir, "README.md"), "# Cart service\n\nA tiny shopping-cart pricing library.\n");
  await exec("git", ["add", "-A"], { cwd: workdir });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: workdir });

  const { rows: projRows } = await h.pool.query<{ id: string }>(
    `insert into projects (org_id, name) values ($1, 'cart-service') returning id`, [h.orgId]);
  const projectId = projRows[0]!.id;
  const sessionId = randomUUID();
  await h.pool.query(
    `insert into sessions (id, org_id, project_id, user_id, title) values ($1,$2,$3,$4,'e2e')`,
    [sessionId, h.orgId, projectId, h.userId]);
  r.check("step1.project_row", !!projectId, `project=${projectId.slice(0, 8)} session=${sessionId.slice(0, 8)}`);
  r.check("step1.git_repo_ready", await new GitService(workdir).isRepo(), `workdir=${workdir}`);

  const toolCtx = { orgId: h.orgId, userId: h.userId, sessionId, projectRoot: workdir };

  // ---------- Step 2: AI가 코드 생성 (실제 도구 루프) ----------
  r.section("Step 2 — Agent writes code (real tool loop)");
  const system = renderTemplate(SYSTEM_CORE_TEMPLATE, { projectName: "cart-service", workdir });
  const conversation: ChatMessage[] = [{
    role: "user",
    content:
      "Create the file src/cart.ts with a TypeScript function `subtotal(items: {price: number; qty: number}[]): number` " +
      "that returns the sum of price*qty. Use the write_file tool to create it. Then stop.",
  }];

  let toolTurns = 0;
  let wroteFile = false;
  const allCalls: ToolCall[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const calls: ToolCall[] = [];
    let text = "";
    let stop = "end_turn";
    for await (const ev of h.router.stream(
      { system, messages: conversation, tools: registry.specs(), maxTokens: 8000 },
      { taskClass: "code", needTools: true },
    )) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "tool_call") calls.push(ev.call);
      if (ev.type === "done") stop = ev.stopReason;
    }
    conversation.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
    if (!calls.length || stop !== "tool_use") break;
    toolTurns++;
    for (const c of calls) {
      allCalls.push(c);
      const res = await executor.execute(toolCtx, c);
      if (c.name === "write_file" && res.ok) wroteFile = true;
      conversation.push({ role: "tool", content: res.output, toolCallId: c.id });
    }
  }

  r.check("step2.agent_used_tools", toolTurns > 0 && allCalls.length > 0,
    `${toolTurns} tool turns, calls: ${allCalls.map((c) => c.name).join(", ")}`);
  r.check("step2.write_tool_succeeded", wroteFile, `write_file executed successfully`);

  const cartSrc = await readFile(join(workdir, "src/cart.ts"), "utf8").catch(() => "");
  r.check("step2.file_exists_on_disk", cartSrc.length > 0, `${cartSrc.length} bytes at src/cart.ts`);
  r.check("step2.code_is_plausible", /subtotal/.test(cartSrc) && /price/.test(cartSrc) && /qty/.test(cartSrc),
    cartSrc.split("\n").find((l) => /subtotal/.test(l))?.trim().slice(0, 80) ?? "(no subtotal line)");

  // 생성된 코드가 실제로 동작하는가 — "그럴듯해 보임"이 아니라 실행 결과로 확인한다.
  // Node 22의 네이티브 타입 스트리핑을 쓴다(직접 만든 정규식 변환은 export 문법에서 깨진다).
  await r.guard("step2.code_runs", async () => {
    const probe = join(workdir, "probe.ts");
    await writeFile(probe,
      `import { subtotal } from "./src/cart.ts";\n` +
      `console.log(subtotal([{ price: 10, qty: 2 }, { price: 5, qty: 3 }]));\n`);
    const { stdout } = await exec("node", ["--experimental-strip-types", "--no-warnings", probe], {
      cwd: workdir, timeout: 20_000,
    });
    r.check("step2.generated_code_is_correct", stdout.trim() === "35", `subtotal([10x2, 5x3]) = ${stdout.trim()} (expected 35)`);
  });

  // ---------- Step 3: Git 자동 커밋 ----------
  r.section("Step 3 — Git auto-commit checkpoint");
  const git = new GitService(workdir);
  const commit = await git.autoCommit("add subtotal helper to cart service");
  r.check("step3.commit_created", !!commit?.sha, `sha=${commit?.sha}`);
  const { stdout: show } = await exec("git", ["show", "--stat", "--format=%s", "HEAD"], { cwd: workdir });
  r.check("step3.commit_contains_file", show.includes("src/cart.ts"), show.split("\n").filter(Boolean).slice(0, 2).join(" | "));

  // ---------- Step 4: 파일 수정 (에이전트 2차 편집) ----------
  r.section("Step 4 — Agent edits the file");
  const editConvo: ChatMessage[] = [{
    role: "user",
    content:
      "Read src/cart.ts, then use write_file to rewrite it so it ALSO exports " +
      "`applyDiscount(total: number, percent: number): number` returning total minus percent%. " +
      "Keep the existing subtotal function. Use the tools, then stop.",
  }];
  let editTurns = 0;
  for (let turn = 0; turn < 5; turn++) {
    const calls: ToolCall[] = [];
    let text = "";
    let stop = "end_turn";
    for await (const ev of h.router.stream(
      { system, messages: editConvo, tools: registry.specs(), maxTokens: 8000 },
      { taskClass: "code", needTools: true },
    )) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "tool_call") calls.push(ev.call);
      if (ev.type === "done") stop = ev.stopReason;
    }
    editConvo.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
    if (!calls.length || stop !== "tool_use") break;
    editTurns++;
    for (const c of calls) {
      const res = await executor.execute(toolCtx, c);
      editConvo.push({ role: "tool", content: res.output, toolCallId: c.id });
    }
  }
  const edited = await readFile(join(workdir, "src/cart.ts"), "utf8").catch(() => "");
  r.check("step4.edit_applied", /applyDiscount/.test(edited), `${editTurns} turns; applyDiscount present=${/applyDiscount/.test(edited)}`);
  r.check("step4.original_preserved", /subtotal/.test(edited), `subtotal still present=${/subtotal/.test(edited)}`);
  r.check("step4.read_before_write", audit.some((a) => a.toolName === "read_file" && a.status === "ok"),
    `agent read the file before rewriting it`);

  const commit2 = await git.autoCommit("add applyDiscount");
  r.check("step4.second_checkpoint", !!commit2?.sha && commit2.sha !== commit?.sha, `sha=${commit2?.sha}`);
  const { stdout: logCount } = await exec("git", ["rev-list", "--count", "HEAD"], { cwd: workdir });
  r.check("step4.history_linear", Number(logCount.trim()) === 3, `${logCount.trim()} commits (initial + 2 checkpoints)`);

  // ---------- Step 5: Memory 저장 ----------
  r.section("Step 5 — Memory persisted");
  const stored = await h.memory.extractAndStore({ orgId: h.orgId, userId: h.userId, projectId },
    randomUUID(),
    [
      { role: "user", content: "For this project always use named exports, never default exports." },
      { role: "assistant", content: "Understood — named exports only in cart-service." },
    ]);
  r.check("step5.facts_extracted", stored > 0, `${stored} facts`);
  const { rows: memRows } = await h.pool.query<{ n: string }>(
    `select count(*)::text as n from memory_items where org_id = $1 and project_id = $2`, [h.orgId, projectId]);
  r.check("step5.persisted_in_db", Number(memRows[0]!.n) > 0, `${memRows[0]!.n} rows scoped to this project`);

  const recalled = await h.memory.ltm.recall({ orgId: h.orgId, userId: h.userId, projectId }, "export style convention", 5);
  r.check("step5.recallable", recalled.some((m) => /export/i.test(m.content)),
    recalled.map((m) => m.content.slice(0, 45)).join(" | ") || "(nothing recalled)");

  // ---------- Step 6: 인덱싱 + RAG ----------
  r.section("Step 6 — Codebase indexed & retrievable");
  const embed = hashEmbedder(h.embedDim ?? undefined);
  const indexer = new Indexer(h.pool, embed);
  const idx = await indexer.indexProject(projectId, workdir);
  r.check("step6.indexed", idx.added > 0, `added=${idx.added} updated=${idx.updated} removed=${idx.removed}`);

  const { rows: chunkRows } = await h.pool.query<{ n: string }>(
    `select count(*)::text as n from code_chunks where project_id = $1`, [projectId]);
  r.check("step6.chunks_written", Number(chunkRows[0]!.n) > 0, `${chunkRows[0]!.n} chunks`);

  const retriever = new CodeRetriever(h.pool, embed);
  const hits = await retriever.retrieve(projectId, "applyDiscount percent", 5);
  r.check("step6.rag_finds_new_code", hits.some((x) => /applyDiscount/.test(x.content)),
    hits.map((x) => `${x.path}:${x.startLine}`).join(", ") || "(no hits)");

  // 증분성: 재실행 시 변경 없는 파일은 다시 임베딩하지 않아야 한다
  const idx2 = await indexer.indexProject(projectId, workdir);
  r.check("step6.incremental", idx2.added === 0 && idx2.updated === 0,
    `second pass: added=${idx2.added} updated=${idx2.updated} (expected 0/0)`);

  // ---------- Step 7: Plugin 호출 ----------
  r.section("Step 7 — Plugin invoked in the same tool pipeline");
  await r.guard("step7.plugin", async () => {
    const { loadPlugin, parseManifest } = await import("@aios/plugin-host");
    const pdir = join(workdir, ".aios-plugin");
    await mkdir(pdir, { recursive: true });
    const bundle = `
import { parentPort } from "node:worker_threads";
let seq = 0; const pending = new Map();
function rpc(m, p) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, {res, rej}); parentPort.postMessage({ id, method: m, params: p }); }); }
const handlers = {
  async loc(args) { return "lines=" + String(args.text ?? "").split("\\n").filter(Boolean).length; },
};
parentPort.on("message", async (msg) => {
  if (msg.method === "tool.invoke") {
    try { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, output: await handlers[msg.params.name](msg.params.args) } }); }
    catch (e) { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, error: String(e) } }); }
    return;
  }
  const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error)) : p.res(msg.result); }
});
await rpc("tools.register", { name: "loc", description: "count non-empty lines in the given text" });
`;
    const bp = join(pdir, "index.mjs");
    await writeFile(bp, bundle);
    const manifest = parseManifest({
      name: "loc-counter", version: "1.0.0", displayName: "LOC", entry: "index.js",
      engines: { aios: ">=0.1.0" }, permissions: ["tools.register"], contributes: { tools: [{ name: "loc", description: "count lines" }] },
    });
    const loaded = await loadPlugin(bp, manifest, createHash("sha256").update(await readFile(bp)).digest("hex"), null, {
      registry, granted: ["tools.register"], kv: { get: async () => null, set: async () => {} },
    });
    await new Promise((res) => setTimeout(res, 800));
    r.check("step7.plugin_tool_registered", registry.list().some((t) => t.name === "plugin__loc-counter__loc"),
      registry.list().map((t) => t.name).filter((n) => n.startsWith("plugin__")).join(", "));

    const pluginExe = new ToolExecutor(registry,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, net: "confirm" }, confirm: async () => true },
      async (rec) => { audit.push(rec); });
    const res = await pluginExe.execute(toolCtx, { id: "p1", name: "plugin__loc-counter__loc", arguments: { text: edited } });
    const expected = edited.split("\n").filter(Boolean).length;
    r.check("step7.plugin_executed", res.ok && res.output === `lines=${expected}`, `${res.output} (expected lines=${expected})`);
    await loaded.stop();
  });

  // ---------- Step 8: 최종 코드 생성 (메모리 + RAG 컨텍스트 주입) ----------
  r.section("Step 8 — Final generation with memory + RAG context");
  const memCtx = await h.memory.buildContext({ orgId: h.orgId, userId: h.userId, projectId }, sessionId, "add a tax helper");
  const ragHits = await retriever.retrieve(projectId, "subtotal applyDiscount cart", 4);
  const assembled = assemblePrompt({
    systemCore: system,
    memoryFacts: memCtx.facts,
    ragChunks: retriever.format(ragHits),
    stmSummary: memCtx.stmSummary,
    history: [],
    userMessage:
      "Using the project's conventions shown above, use write_file to create src/tax.ts exporting " +
      "`withTax(total: number, rate: number): number`. Follow the same export style as the existing code. Then stop.",
    budgetTokens: 60_000,
  });
  r.check("step8.context_assembled",
    assembled.system.includes("Long-term memory") && assembled.system.includes("Relevant code"),
    `system=${assembled.usedTokens} tokens, ${memCtx.facts.length} facts + ${ragHits.length} chunks`);

  const finalConvo: ChatMessage[] = [...assembled.messages];
  for (let turn = 0; turn < 4; turn++) {
    const calls: ToolCall[] = [];
    let text = "";
    let stop = "end_turn";
    for await (const ev of h.router.stream(
      { system: assembled.system, messages: finalConvo, tools: registry.specs(), maxTokens: 8000 },
      { taskClass: "code", needTools: true },
    )) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "tool_call") calls.push(ev.call);
      if (ev.type === "done") stop = ev.stopReason;
    }
    finalConvo.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
    if (!calls.length || stop !== "tool_use") break;
    for (const c of calls) {
      const res = await executor.execute(toolCtx, c);
      finalConvo.push({ role: "tool", content: res.output, toolCallId: c.id });
    }
  }
  const tax = await readFile(join(workdir, "src/tax.ts"), "utf8").catch(() => "");
  r.check("step8.final_file_written", tax.length > 0, `${tax.length} bytes at src/tax.ts`);
  r.check("step8.follows_convention", /export\s+(const|function)\s+withTax/.test(tax) && !/export\s+default/.test(tax),
    `named export used (memory said: named exports only) — "${tax.split("\n").find((l) => /withTax/.test(l))?.trim().slice(0, 70)}"`);

  const finalCommit = await git.autoCommit("add withTax helper");
  r.check("step8.final_checkpoint", !!finalCommit?.sha, `sha=${finalCommit?.sha}`);

  // ---------- 전체 파이프라인 사후 상태 ----------
  r.section("Pipeline post-conditions");
  const files = await readdir(join(workdir, "src"));
  r.check("e2e.all_artifacts_present", files.includes("cart.ts") && files.includes("tax.ts"), `src/: ${files.join(", ")}`);
  const { stdout: finalLog } = await exec("git", ["log", "--oneline"], { cwd: workdir });
  r.check("e2e.commit_trail", finalLog.split("\n").filter(Boolean).length >= 4,
    finalLog.trim().split("\n").map((l) => l.slice(0, 40)).join(" / "));
  // 최소 4회: 파일 생성 / 읽기 / 재작성 / 최종 생성. 정확한 횟수는 모델 행동에 따라 달라진다.
  r.check("e2e.audit_trail", audit.length >= 4 && audit.every((a) => a.sessionId === sessionId),
    `${audit.length} tool invocations (${audit.map((a) => a.toolName).join(", ")}), all bound to session ${sessionId.slice(0, 8)}`);
  r.check("e2e.no_silent_failures", audit.filter((a) => a.status === "error").length === 0 ||
    audit.filter((a) => a.status === "error").every((a) => a.toolName === "read_file"),
    `errors: ${audit.filter((a) => a.status === "error").map((a) => a.toolName).join(", ") || "none"}`);
} finally {
  await cleanupTempDirs();
  await h.close();
}

r.finish();
