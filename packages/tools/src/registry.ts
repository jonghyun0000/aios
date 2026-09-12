import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AiosError } from "@aios/shared";
import type { ToolSpec } from "@aios/shared";

/**
 * Tool Registry — 도구의 단일 정의 지점.
 *
 * zod 스키마 하나로: (1) LLM에 보낼 JSON Schema 생성, (2) 모델이 만든 인자의 런타임 검증.
 * LLM은 스키마를 어긴 인자를 '정말로' 만든다. 검증 없는 도구 실행은 프로덕션 사고의 지름길.
 */

export type ToolPermission = "read" | "write" | "exec" | "net";
export interface ToolOutput { output: string; exitCode: number }

export interface ToolContext {
  orgId: string;
  userId?: string;
  sessionId: string;
  projectRoot: string;
  signal: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  permission: ToolPermission;
  /** true면 executor가 반드시 샌드박스 경로로 실행 */
  requiresSandbox?: boolean;
  handler: (ctx: ToolContext, args: z.infer<S>) => Promise<string | ToolOutput>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new AiosError("tool_conflict", `tool '${def.name}' already registered`, { status: 500 });
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) {
      throw new AiosError("tool_invalid_name", `invalid tool name '${def.name}'`, { status: 500 });
    }
    this.tools.set(def.name, def);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** LLM 프로바이더에 넘길 스펙 (4사 공통 JSON Schema) */
  specs(): ToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, { $refStrategy: "none" }),
    }));
  }
}
