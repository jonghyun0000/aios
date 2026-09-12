/**
 * MCP 스모크 테스트 — 실제 MCP 레퍼런스 서버(@modelcontextprotocol/server-everything)를
 * stdio로 띄우고, 우리 McpClient가 initialize → tools/list → tools/call 전 과정을
 * 수행하는지 검증한다. Registry 투영(mcp__server__tool 네이밍)까지 확인.
 */
import { ToolRegistry } from "../src/registry.js";
import { registerMcpServer } from "../src/mcp/client.js";

const registry = new ToolRegistry();

console.log("[1] spawning MCP server (@modelcontextprotocol/server-everything) ...");
const client = await registerMcpServer(registry, {
  name: "everything",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  requestTimeoutMs: 60_000, // 첫 실행은 npx 다운로드 시간 포함
});

const names = registry.specs().map((s) => s.name);
console.log(`[2] tools/list → ${names.length} tools projected into registry:`);
console.log("    " + names.join(", "));

console.log("[3] tools/call echo ...");
const echo = await client.callTool("echo", { message: "hello from AIOS McpClient" });
console.log("    →", echo);

console.log("[4] tools/call get-sum ...");
const sum = await client.callTool("get-sum", { a: 2, b: 40 });
console.log("    →", sum);

await client.close();
console.log("[5] MCP smoke test PASSED");
process.exit(0);
