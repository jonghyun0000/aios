import { ToolDeniedError, ToolExecutionError, ValidationError } from "@aios/shared";
import type { ToolCall } from "@aios/shared";
import type { ToolContext, ToolPermission, ToolRegistry } from "./registry.js";

/**
 * Tool Executor — 모든 도구 호출의 단일 관문 (OS의 syscall 게이트에 해당).
 *
 * 책임: 정책 검사 → 인자 검증 → 타임아웃 실행 → 출력 절단 → 감사 로그.
 * 이 다섯 가지를 도구 구현체가 아닌 관문에서 강제하는 이유:
 * 도구가 100개가 되어도 보안 불변식은 한 곳에만 존재해야 한다.
 */

export type PolicyMode = "auto" | "confirm" | "deny";

export interface ExecutionPolicy {
  /** permission 등급별 실행 모드. exec 기본값이 confirm인 것이 핵심 방어선. */
  modes: Record<ToolPermission, PolicyMode>;
  /** confirm 모드에서 사용자 승인을 얻는 콜백 (UI/CLI가 주입) */
  confirm?: (call: ToolCall, permission: ToolPermission) => Promise<boolean>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const DEFAULT_POLICY: ExecutionPolicy = {
  modes: { read: "auto", write: "auto", exec: "confirm", net: "confirm" },
  timeoutMs: 60_000,
  maxOutputBytes: 32 * 1024,
};

export interface ToolAuditRecord {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "ok" | "error" | "denied" | "timeout";
  durationMs: number;
  sandboxed: boolean;
  resultPreview?: string;
}

export type AuditFn = (record: ToolAuditRecord) => Promise<void>;

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number;
}

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private policy: ExecutionPolicy = DEFAULT_POLICY,
    private audit?: AuditFn,
  ) {}

  async execute(ctx: Omit<ToolContext, "signal">, call: ToolCall, signal?: AbortSignal, confirm?: ExecutionPolicy["confirm"]): Promise<ToolResult> {
    signal?.throwIfAborted();
    const started = Date.now();
    const def = this.registry.get(call.name);

    const record = async (status: ToolAuditRecord["status"], preview?: string) => {
      await this.audit
        ?.({
          sessionId: ctx.sessionId,
          toolName: call.name,
          args: call.arguments,
          status,
          durationMs: Date.now() - started,
          sandboxed: def?.requiresSandbox ?? false,
          resultPreview: preview?.slice(0, 500),
        })
        .catch(() => {}); // 감사 로그 실패가 도구 결과를 삼켜선 안 되지만, 별도 알림 대상
    };

    if (!def) {
      await record("error");
      return { ok: false, output: `unknown tool: ${call.name}` };
    }

    // 승인 화면과 실제 실행은 같은 검증된 인자를 사용한다.
    const parsed = def.schema.safeParse(call.arguments);
    if (!parsed.success) {
      await record("error");
      return { ok: false, output: `invalid arguments: ${formatZodError(parsed.error)}` };
    }
    // --- 1) 정책 ---
    const mode = this.policy.modes[def.permission];
    if (mode === "deny") {
      await record("denied");
      throw new ToolDeniedError(call.name, `permission '${def.permission}' is denied by policy`);
    }
    if (mode === "confirm") {
      const approval = confirm ?? this.policy.confirm;
      const approved = approval ? await approval(call, def.permission) : false;
      if (!approved) {
        await record("denied");
        return { ok: false, output: `user denied '${call.name}' (${def.permission})` };
      }
    }

    // --- 3) 타임아웃 실행 ---
    const ac = new AbortController();
    const timeoutMs = this.policy.timeoutMs ?? 60_000;
    const timer = setTimeout(() => ac.abort(new Error("tool timeout")), timeoutMs);
    const onAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const raw = await def.handler({ ...ctx, signal: ac.signal }, parsed.data);
      const exitCode = typeof raw === "string" ? undefined : raw.exitCode;
      const output = truncate(typeof raw === "string" ? raw : raw.output, this.policy.maxOutputBytes ?? 32 * 1024);
      const ok = exitCode === undefined || exitCode === 0;
      await record(ok ? "ok" : "error", output);
      return { ok, output, ...(exitCode === undefined ? {} : { exitCode }) };
    } catch (err) {
      signal?.throwIfAborted();
      const timedOut = ac.signal.aborted;
      await record(timedOut ? "timeout" : "error");
      if (timedOut) return { ok: false, output: `tool '${call.name}' timed out after ${timeoutMs}ms` };
      const msg = err instanceof Error ? err.message : String(err);
      // 도구 에러도 모델에 피드백 — 루프에서 재시도/우회 판단은 모델의 몫
      return { ok: false, output: `tool '${call.name}' failed: ${msg}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  return `${buf.subarray(0, maxBytes).toString("utf8")}\n...[truncated ${buf.byteLength - maxBytes} bytes]`;
}

function formatZodError(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export { ValidationError, ToolExecutionError };
