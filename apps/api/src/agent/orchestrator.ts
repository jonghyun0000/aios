import { randomUUID } from "node:crypto";
import { assemblePrompt, chooseChatStrategy, renderTemplate, CHAT_SYSTEM_TEMPLATE, SYSTEM_CORE_TEMPLATE } from "@aios/ai";
import { estimateMessagesTokens, estimateTokens, ValidationError } from "@aios/shared";
import type { AgentEvent, ChatMessage, ChatMode, ReasoningMode, TaskClass, ToolCall } from "@aios/shared";
import { evaluateCompletion, type CompletionCheck } from "@aios/ai";
import { GitService } from "@aios/tools";
import type { AppContext } from "../context.js";
import type { ExecutionRun } from "../execution/service.js";

/**
 * Agent Orchestrator — AIOS의 "커널 메인 루프".
 *
 * 한 턴의 구조: 컨텍스트 수집(병렬) → 프롬프트 조립 → 라우팅/스트림 →
 * tool_call이 있으면 실행 후 결과를 대화에 주입하고 재호출 (최대 MAX_TURNS).
 *
 * MAX_TURNS=8 인 이유: 도구 루프의 폭주(모델이 같은 실패를 무한 반복)는 실제로 일어난다.
 * 상한은 비용 사고와 무한 루프를 동시에 막는 회로 차단기다.
 */

const MAX_TURNS = 8;

export interface RunInput {
  orgId: string;
  userId?: string;
  sessionId: string;
  projectId?: string;
  projectRoot?: string;
  projectName?: string;
  content: string;
  savedHistory?: ChatMessage[];
  references?: string[];
  mode?: ChatMode;
  taskClass?: TaskClass;
  model?: string;
  maxCostUsd?: number;
  toolsEnabled: boolean;
  useRag: boolean;
  useMemory: boolean;
  useLongTermMemory?: boolean;
  reasoning?: ReasoningMode;
  budgetTokens?: number;
  signal?: AbortSignal;
  /**
   * '완료'의 정의. 주면 모델이 멈출 때 시스템이 검사하고, 미완이면 루프를 이어 간다.
   * 주지 않으면 게이트는 없다 — 무엇이 완료인지 모르는 채 다그치면 단순 질문에서 오작동한다.
   */
  completionCheck?: CompletionCheck;
  execution?: ExecutionRun;
}

export class AgentOrchestrator {
  constructor(private ctx: AppContext) {}

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    input.signal?.throwIfAborted();
    const { ctx } = this;
    const started = performance.now();
    const strategy = input.mode ? chooseChatStrategy(input.content, input.mode, input.toolsEnabled) : null;
    if (strategy) {
      input = { ...input, reasoning: strategy.path === "thorough" ? "auto" : "off",
        useLongTermMemory: strategy.path === "thorough" && input.useLongTermMemory !== false,
        useRag: strategy.path === "thorough" && input.useRag,
        taskClass: input.toolsEnabled ? "code" : strategy.path === "thorough" ? "reasoning" : "chat" };
      yield { type: "strategy", mode: input.mode!, path: strategy.path, reason: strategy.reason };
    }
    const maxTokens = !strategy ? 8192 : strategy.path === "fast" ? 2048 : 4096;
    const localWindow = strategy && ctx.env?.LOCAL_LLM_BASE_URL ? ctx.env.LOCAL_LLM_CONTEXT : undefined;
    const budgetTokens = input.budgetTokens ?? (localWindow ? Math.max(512, localWindow - maxTokens - 256) : 100_000);
    if (strategy?.path !== "calculator" && estimateTokens(input.content) > budgetTokens * 0.85) {
      throw new ValidationError("메시지가 모델의 입력 한도를 넘습니다. 내용을 나누어 보내주세요.");
    }
    const scope = { orgId: input.orgId, userId: input.userId, projectId: input.projectId };

    // --- 0) 사용자 메시지 영속화 + STM 기록 ---
    const userMsg: ChatMessage = { role: "user", content: input.content };
    const inputSaving = performance.now();
    await Promise.all([
      this.persistMessage(input.sessionId, userMsg),
      ctx.memory.record(input.sessionId, userMsg),
    ]);
    yield { type: "timing", phase: "save_input", durationMs: performance.now() - inputSaving };
    if (strategy?.calculation) {
      input.signal?.throwIfAborted();
      yield { type: "timing", phase: "first_text", durationMs: performance.now() - started };
      yield { type: "text_delta", text: strategy.calculation.text };
      const saving = performance.now();
      await this.finishTurn(input, strategy.calculation.text);
      yield { type: "timing", phase: "save_output", durationMs: performance.now() - saving };
      yield { type: "timing", phase: "total", durationMs: performance.now() - started };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }

    // --- 1) 컨텍스트 수집 (병렬 — TTFT 방어) ---
    const contextStarted = performance.now();
    const [memCtx, ragHits] = await Promise.all([
      input.useMemory
        ? ctx.memory.buildContext(scope, input.sessionId, input.content, { useLongTermMemory: input.useLongTermMemory })
        : Promise.resolve({ stmSummary: null, history: [] as ChatMessage[], facts: [] as string[] }),
      input.useRag && input.projectId
        ? ctx.retriever.retrieve(input.projectId, input.content).catch(() => [])
        : Promise.resolve([]),
    ]);
    yield { type: "timing", phase: "context", durationMs: performance.now() - contextStarted };

    // --- 2) 프롬프트 조립 ---
    const systemCore = input.mode && !input.toolsEnabled ? CHAT_SYSTEM_TEMPLATE : renderTemplate(SYSTEM_CORE_TEMPLATE, {
      projectName: input.projectName ?? "(none)",
      workdir: input.projectRoot ?? "(none)",
    });
    const assembled = assemblePrompt({
      systemCore: systemCore + (input.execution ? "\nSafety: All file writes and commands require explicit user approval. Commands have a read-only workspace and no network. Use write_file for edits. Do not claim verification from your own prose. Refusal means stop, not retry. Do not auto-commit." : ""),
      memoryFacts: memCtx.facts,
      ragChunks: [...(input.references ?? []), ...ctx.retriever.format(ragHits)],
      // 캐시 요약과 원문을 함께 넣으면 같은 사실이 중복되므로 DB 복원 시 요약을 제외한다.
      stmSummary: input.savedHistory ? null : memCtx.stmSummary,
      history: input.savedHistory ?? memCtx.history.slice(0, -1),
      userMessage: input.content,
      budgetTokens,
    });
    if (assembled.dropped.length) yield { type: "context_trimmed", sections: assembled.dropped };

    const toolSpecs = input.toolsEnabled ? ctx.tools.specs() : undefined;
    const conversation: ChatMessage[] = [...assembled.messages];

    let fullText = "";
    let filesMutated = false;
    let incompleteRetries = 0;
    let firstText = false;
    let terminalError: string | undefined;
    let ended = false;

    // --- 3) 도구 루프 ---
    toolLoop: for (let turn = 0; turn < MAX_TURNS; turn++) {
      input.signal?.throwIfAborted();
      const pendingCalls: ToolCall[] = [];
      let turnText = "";
      let stopReason: string = "error";

      const stream = ctx.router.stream(
        { system: assembled.system, messages: conversation, tools: toolSpecs, maxTokens, reasoning: input.reasoning, abortSignal: input.signal },
        {
          taskClass: input.taskClass ?? "code",
          model: input.model,
          needTools: input.toolsEnabled,
          maxCostUsd: input.maxCostUsd,
          estimatedInputTokens:
            estimateTokens(assembled.system) + estimateMessagesTokens(conversation),
        },
      );

      for await (const ev of stream) {
        switch (ev.type) {
          case "text_delta":
            if (!firstText) { firstText = true; yield { type: "timing", phase: "first_text", durationMs: performance.now() - started }; }
            turnText += ev.text;
            yield ev;
            break;
          case "tool_call":
            pendingCalls.push(ev.call);
            break;
          case "done":
            stopReason = ev.stopReason;
            // 모델의 종료는 작업 종료가 아니다. 저장·검증 뒤 done을 한 번만 보낸다.
            break;
          default:
            yield ev; // routed / usage 등은 그대로 통과
        }
      }

      fullText += turnText;
      if (stopReason === "max_tokens" || stopReason === "error") {
        terminalError = stopReason === "max_tokens" ? "출력 한도로 응답이 잘렸습니다. 질문을 나누거나 빠른 모드로 다시 시도해 주세요." : "모델 응답이 정상 종료되지 않았습니다.";
        yield { type: "error", code: stopReason === "max_tokens" ? "response_truncated" : "response_incomplete", message: terminalError };
        ended = true; break;
      }
      conversation.push({ role: "assistant", content: turnText, toolCalls: pendingCalls.length ? pendingCalls : undefined });

      if (pendingCalls.length === 0 || stopReason !== "tool_use") {
        /*
         * 모델이 멈췄다. 호출자가 '완료'의 정의를 줬다면 그것이 사실인지 확인한다.
         * 모델이 "고치겠다"고 설명만 하고 끝내는 일이 실제로 반복됐고,
         * 프롬프트로는 막지 못했다 — 근거는 packages/ai/src/completion-gate.ts.
         */
        const gate = await evaluateCompletion({
          check: input.completionCheck,
          retriesSoFar: incompleteRetries,
        });
        if (gate.error) terminalError = gate.reason;
        if (!gate.proceed) { ended = true; break; }
        incompleteRetries++;
        // 조용히 재시도하지 않는다. 사용자와 로그가 무슨 일이 있었는지 볼 수 있어야 한다.
        yield { type: "incomplete", reason: gate.reason ?? "", attempt: incompleteRetries };
        conversation.push({ role: "user", content: gate.nudge! });
        continue;
      }

      // --- 도구 실행 (호출 순서대로 — 파일 편집은 순서 의존적이라 병렬화하지 않는다) ---
      for (const call of pendingCalls) {
        input.signal?.throwIfAborted();
        yield { type: "tool_start", call };
        const toolStarted = performance.now();
        const result = input.execution ? await input.execution.execute(call) : await ctx.executor.execute(
          {
            orgId: input.orgId,
            userId: input.userId,
            sessionId: input.sessionId,
            projectRoot: input.projectRoot ?? process.cwd(),
          },
          call,
          input.signal,
        );
        yield { type: "timing", phase: "tools", durationMs: performance.now() - toolStarted };
        if (call.name === "write_file" && result.ok) filesMutated = true;
        yield { type: "tool_result", id: call.id, ok: result.ok, summary: result.output.slice(0, 200) };
        // toolCallId는 프로바이더가 준 원본 id 그대로여야 한다.
        // Anthropic의 tool_use_id는 ^[a-zA-Z0-9_-]+$ 만 허용하므로 구분자를 덧붙이면 400이 난다
        // (Phase 5에서 실제로 발견). Gemini는 어댑터가 대화에서 id→이름을 역인덱싱해 해결한다.
        conversation.push({ role: "tool", content: result.output, toolCallId: call.id });
        if (input.execution?.halted) {
          const text = "\n\n승인이 거절되거나 만료되어 실행을 멈췄습니다. 이미 저장한 변경은 실행 기록에서 확인·복구할 수 있습니다.";
          fullText += text; yield { type: "text_delta", text }; ended = true; break toolLoop;
        }
      }
    }

    /*
     * 루프가 턴 소진으로 끝났을 수 있다.
     *
     * 게이트는 "모델이 스스로 멈췄을 때"만 돈다. 모델이 MAX_TURNS 를 전부 도구 호출로
     * 쓰면 그 분기를 타지 않고 루프가 조용히 끝나고, 호출자는 완료된 줄 안다.
     * 재시도할 턴은 남지 않았지만, **완료되지 않았다는 사실은 반드시 알려야 한다** —
     * 조용한 미완이 조용한 실패로 이어진다.
     */
    input.signal?.throwIfAborted();
    if (!ended) {
      terminalError = "최대 도구 반복 횟수에 도달했습니다. 작업 완료 여부를 확인하지 못했습니다.";
      yield { type: "incomplete", reason: terminalError, attempt: incompleteRetries + 1 };
    }
    if (input.completionCheck) {
      const final = await input.completionCheck().catch(() => ({ done: false, reason: "완료 검증 실행에 실패했습니다." }));
      if (!final.done) {
        terminalError = final.reason;
        yield { type: "incomplete", reason: final.reason, attempt: incompleteRetries + 1 };
      }
    }

    // --- 4) Git 자동 커밋 (파일 변경이 있었던 턴만) ---
    if (filesMutated && input.projectRoot && !input.execution) {
      try {
        const git = new GitService(input.projectRoot);
        const commit = await git.autoCommit(input.content);
        if (commit) yield { type: "commit", sha: commit.sha, message: commit.message };
      } catch (err) {
        // 커밋 실패(훅 거부 등)는 응답을 죽이지 않는다 — 이벤트로 알리고 계속
        yield { type: "error", code: "git_commit_failed", message: err instanceof Error ? err.message : String(err) };
      }
    }

    // --- 5) 마무리: 영속화 + 비동기 후처리 ---
    if (!fullText.trim()) throw new Error("모델이 표시 가능한 답변을 반환하지 않았습니다. 질문을 나누거나 다시 시도해 주세요.");
    if (!terminalError) await input.execution?.verify();
    const saving = performance.now();
    await this.finishTurn(input, fullText);
    await input.execution?.finish(terminalError);
    yield { type: "timing", phase: "save_output", durationMs: performance.now() - saving };
    yield { type: "timing", phase: "total", durationMs: performance.now() - started };
    yield { type: "done", stopReason: terminalError ? "error" : "end_turn" };
  }

  private async finishTurn(input: RunInput, fullText: string): Promise<void> {
    input.signal?.throwIfAborted();
    const { ctx } = this;
    const assistantMsg: ChatMessage = { role: "assistant", content: fullText };
    await Promise.all([
      this.persistMessage(input.sessionId, assistantMsg),
      ctx.memory.record(input.sessionId, assistantMsg),
    ]);

    // 메모리 압축·사실 추출은 응답 경로 밖 — EventBus로 워커에 위임
    await ctx.bus.publish({
      type: "session.turn_completed",
      orgId: input.orgId,
      payload: { sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, extractFacts: input.useMemory && input.useLongTermMemory !== false },
    });
  }

  private async persistMessage(sessionId: string, m: ChatMessage): Promise<void> {
    await this.ctx.pool.query(
      `insert into messages (id, session_id, role, content) values ($1, $2, $3, $4)`,
      [randomUUID(), sessionId, m.role, JSON.stringify({ text: m.content, toolCalls: m.toolCalls ?? null })],
    );
    // 최근 대화 순서는 생성일이 아니라 마지막 메시지 시각이다.
    await this.ctx.pool.query("update sessions set updated_at = now() where id = $1", [sessionId]);
  }
}
