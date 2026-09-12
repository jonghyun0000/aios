import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../registry.js";
import { ToolExecutor } from "../executor.js";
import { jailPath } from "../builtin/fs.js";

const context = { orgId: "org", sessionId: "session", projectRoot: "/workspace" };
describe("실행 증거와 승인 관문", () => {
  it("종료 코드 42를 실패로 판정하고 stdout의 성공 주장을 신뢰하지 않는다", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "test", permission: "exec", schema: z.object({}), description: "test", handler: async () => ({ exitCode: 42, output: "ALL TESTS PASSED" }) });
    const audit = vi.fn(async () => {});
    const executor = new ToolExecutor(registry, { modes: { read: "auto", write: "confirm", exec: "confirm", net: "deny" } }, audit);
    const result = await executor.execute(context, { id: "a", name: "test", arguments: {} }, undefined, async () => true);
    expect(result).toEqual({ ok: false, exitCode: 42, output: "ALL TESTS PASSED" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    expect(() => expect({ ...result, ok: true }).toMatchObject({ ok: false })).toThrow();
  });
  it("승인이 없으면 write·exec 핸들러가 절대 실행되지 않는다", async () => {
    const handler = vi.fn(async () => "written");
    const registry = new ToolRegistry();
    registry.register({ name: "write_file", permission: "write", schema: z.object({ content: z.string() }), description: "test", handler });
    const executor = new ToolExecutor(registry, { modes: { read: "auto", write: "confirm", exec: "confirm", net: "deny" } });
    expect((await executor.execute(context, { id: "a", name: "write_file", arguments: { content: "danger" } })).ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    const confirm = vi.fn(async () => true);
    expect((await executor.execute(context, { id: "a", name: "write_file", arguments: {} }, undefined, confirm)).ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
  it("취소된 요청은 승인 콜백도 부르지 않고 .GIT 경로도 거부한다", async () => {
    const confirm = vi.fn();
    const executor = new ToolExecutor(new ToolRegistry());
    await expect(executor.execute(context, { id: "a", name: "test", arguments: {} }, AbortSignal.abort(), confirm)).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled(); expect(() => jailPath("/workspace", ".GIT/config")).toThrow();
  });
});
