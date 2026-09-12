#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { AiosClient } from "@aios/sdk";

/**
 * AIOS CLI — Windows/macOS/Linux 공통 (Node 20+, 플랫폼 API 미사용).
 * 설정은 ~/.aios/config.json — 환경변수 AIOS_API_KEY가 항상 우선(CI 친화).
 */

const CONFIG_DIR = join(homedir(), ".aios");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface Config {
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return {};
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // 키 파일은 소유자 전용
}

async function client(): Promise<AiosClient> {
  const cfg = await loadConfig();
  const apiKey = process.env.AIOS_API_KEY ?? cfg.apiKey;
  if (!apiKey) {
    console.error("Not logged in. Run: aios login");
    process.exit(1);
  }
  return new AiosClient({ apiKey, baseUrl: process.env.AIOS_BASE_URL ?? cfg.baseUrl });
}

const program = new Command("aios").description("AIOS — AI operating system CLI").version("0.1.0");

program
  .command("login")
  .description("Save API key (create one in the dashboard)")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const apiKey = (await rl.question("API key (aios_...): ")).trim();
    const baseUrl = (await rl.question("API URL [https://api.aios.dev]: ")).trim() || undefined;
    rl.close();
    await saveConfig({ ...(await loadConfig()), apiKey, baseUrl });
    console.log(`Saved to ${CONFIG_PATH}`);
  });

program
  .command("chat")
  .description("Interactive agent session in the current directory")
  .option("-m, --model <model>", "pin a specific model")
  .option("--no-tools", "disable tool calling")
  .action(async (opts: { model?: string; tools: boolean }) => {
    const api = await client();
    const cfg = await loadConfig();
    const session = await api.createSession({ projectId: cfg.projectId });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`session ${session.id} — Ctrl+C to exit`);

    for (;;) {
      const input = (await rl.question("\n> ")).trim();
      if (!input) continue;
      for await (const ev of api.sendMessage(session.id, input, {
        model: opts.model,
        toolsEnabled: opts.tools,
        projectRoot: process.cwd(),
      })) {
        switch (ev.type) {
          case "routed":
            process.stderr.write(`[${ev.provider}/${ev.model}]\n`);
            break;
          case "text_delta":
            process.stdout.write(ev.text);
            break;
          case "tool_start":
            process.stderr.write(`\n[tool] ${ev.call.name}(${JSON.stringify(ev.call.arguments).slice(0, 120)})\n`);
            break;
          case "commit":
            process.stderr.write(`\n[git] checkpoint ${ev.sha}\n`);
            break;
          case "usage":
            process.stderr.write(`\n[usage] in=${ev.usage.inputTokens} out=${ev.usage.outputTokens} $${ev.usage.costUsd?.toFixed(4) ?? "?"}\n`);
            break;
          case "error":
            process.stderr.write(`\n[error] ${ev.code}: ${ev.message}\n`);
            break;
        }
      }
      console.log();
    }
  });

program
  .command("index")
  .description("Index the current directory into the project's codebase index")
  .requiredOption("-p, --project <id>", "project id")
  .action(async (opts: { project: string }) => {
    const api = await client();
    const { jobId } = await api.triggerIndex(opts.project, process.cwd());
    console.log(`indexing started, job ${jobId}`);
  });

program
  .command("search <query>")
  .description("Hybrid code search (RAG)")
  .requiredOption("-p, --project <id>", "project id")
  .action(async (query: string, opts: { project: string }) => {
    const api = await client();
    for (const hit of await api.search(opts.project, query)) {
      console.log(`\n--- ${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(3)})`);
      console.log(hit.content.slice(0, 400));
    }
  });

program
  .command("models")
  .description("Show router catalog and health")
  .action(async () => {
    console.log(JSON.stringify(await (await client()).models(), null, 2));
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
