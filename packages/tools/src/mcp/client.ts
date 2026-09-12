import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { AiosError } from "@aios/shared";
import type { ToolDefinition, ToolRegistry } from "../registry.js";

/**
 * MCP(Model Context Protocol) 클라이언트 — stdio transport.
 * 프로토콜: JSON-RPC 2.0, 한 줄에 하나의 메시지(newline-delimited).
 *
 * MCP를 자체 도구 규격 대신 지원하는 이유: 도구 생태계를 우리가 전부 만들 수 없다.
 * 외부 MCP 서버의 도구를 Registry에 투영해 우리 도구와 '동일한 정책·감사 경로'를 태운다 —
 * 외부 도구라고 executor의 관문을 우회하면 보안 모델 전체가 무너진다.
 */

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()),
});

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private timeoutMs: number;

  constructor(private config: McpServerConfig) {
    this.timeoutMs = config.requestTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.config.env },
    });
    this.child.on("exit", (code) => {
      const err = new AiosError("mcp_exit", `mcp server '${this.config.name}' exited (${code})`, { status: 502 });
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));

    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "aios", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // 서버의 비-JSON 로그 라인은 무시
      }
      if (msg.id === undefined) continue; // 서버발 notification은 현재 미사용
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AiosError("mcp_error", msg.error.message, { status: 502 }));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AiosError("mcp_timeout", `mcp '${method}' timed out`, { status: 504, retryable: true }));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child!.stdin!.write(payload + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools(): Promise<z.infer<typeof McpToolSchema>[]> {
    const res = (await this.request("tools/list", {})) as { tools?: unknown[] };
    return z.array(McpToolSchema).parse(res.tools ?? []);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n");
    if (res.isError) throw new AiosError("mcp_tool_error", text || "mcp tool failed", { status: 500 });
    return text;
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }
}

/**
 * MCP 서버의 도구들을 Registry에 투영. 이름은 mcp__<server>__<tool>.
 * permission을 'net'으로 두는 이유: MCP 서버는 임의의 외부 효과를 가질 수 있으므로
 * 기본 정책(confirm)의 보호를 받아야 한다. 신뢰하는 서버는 정책에서 개별 완화.
 */
export async function registerMcpServer(registry: ToolRegistry, config: McpServerConfig): Promise<McpClient> {
  const client = new McpClient(config);
  await client.connect();
  const tools = await client.listTools();
  for (const t of tools) {
    const def: ToolDefinition = {
      name: `mcp__${config.name}__${t.name}`,
      description: t.description ?? `MCP tool ${t.name} from ${config.name}`,
      permission: "net",
      schema: z.record(z.unknown()), // 원 스키마는 프로바이더에 전달, 검증은 MCP 서버 측 책임
      handler: (_ctx, args) => client.callTool(t.name, args as Record<string, unknown>),
    };
    registry.register(def);
  }
  return client;
}
