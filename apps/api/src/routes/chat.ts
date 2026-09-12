import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import { loadReferences, loadSavedHistory, referenceChunks, sessionLocks } from "../workspace.js";
import { executionService, type ExecutionRun } from "../execution/service.js";
import { registerExecutionRoutes } from "./execution.js";
import { requireRole } from "../auth.js";

const BodySchema = z.object({
  content: z.string().min(1).max(100_000),
  verificationCommand: z.string().trim().min(1).max(4000).optional(),
  mode: z.enum(["auto", "fast", "thorough"]).optional(),
  routing: z
    .object({
      taskClass: z.enum(["chat", "code", "reasoning", "summarize", "cheap", "vision"]).optional(),
      model: z.string().optional(),
      maxCostUsd: z.number().positive().optional(),
      reasoning: z.enum(["auto", "off"]).optional(),
    })
    .default({}),
  tools: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  context: z
    .object({
      useRag: z.boolean().default(true),
      useMemory: z.boolean().default(true),
      useLongTermMemory: z.boolean().default(true),
      projectRoot: z.string().optional(), // 로컬 실행 모드(CLI/확장)에서 도구의 작업 디렉토리
    })
    .default({ useRag: true, useMemory: true, useLongTermMemory: true }),
});

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerExecutionRoutes(app, ctx);
  const orchestrator = new AgentOrchestrator(ctx);
  const running = sessionLocks(ctx);

  app.post("/v1/sessions/:id/messages", async (req, reply) => {
    // 도구를 끈 대화도 메시지를 저장하고 모델 비용을 발생시킨다. viewer는 읽기만 허용한다.
    requireRole(req.auth, "member");
    const { id: sessionId } = req.params as { id: string };
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("invalid body", parsed.error.issues);
    const body = parsed.data;
    if (body.tools.enabled) {
      if (!ctx.env.LOCAL_WORKSPACE_ROOT) throw new ValidationError("안전 실행용 LOCAL_WORKSPACE_ROOT가 필요합니다. 도구를 끄거나 작업 폴더를 설정해 주세요.");
      await executionService(ctx).assertOrg(req.auth.orgId);
    }
    if (body.verificationCommand && !body.tools.enabled) throw new ValidationError("검증 명령은 도구 사용을 켜야 실행할 수 있습니다.");
    if (running.has(sessionId)) return reply.code(409).send({ error: { code: "session_busy", message: "이 대화에서 응답 생성 또는 변경 중입니다." } });
    running.add(sessionId);
    let execution: ExecutionRun | undefined;
    try {

    // 세션 소유권 확인 — 테넌트 격리는 모든 조회의 첫 조건
    const { rows } = await ctx.pool.query<{ project_id: string | null; name: string | null }>(
      `select p.id as project_id, p.name
         from sessions s left join projects p on p.id = s.project_id and p.org_id = s.org_id
        where s.id = $1 and s.org_id = $2 and s.deleted_at is null`,
      [sessionId, req.auth.orgId],
    );
    const session = rows[0];
    if (!session) throw new NotFoundError("session");

    // 쿼터는 스트림 시작 전에 확인 — 시작한 스트림을 끊는 것보다 싸고 정직하다
    if (req.auth.via !== "local") await ctx.usage.checkQuota(req.auth.orgId);
    ctx.usage.bind({ orgId: req.auth.orgId, userId: req.auth.userId, sessionId });
    // Redis는 만료되는 캐시다. 웹 대화는 저장된 최근 100개 메시지를 매번 원본으로 사용한다.
    const [savedHistory, files] = body.mode ? await Promise.all([
      body.context.useMemory ? loadSavedHistory(ctx, req.auth.orgId, sessionId) : Promise.resolve([]),
      loadReferences(ctx, req.auth.orgId, sessionId, session.project_id),
    ]) : [undefined, []];
    const references = referenceChunks(files, body.content);
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", onClose);

    // SSE는 reply.raw에 직접 쓴다 — hijack으로 fastify의 자동 응답 전송을 중단시켜야
    // 핸들러 종료 시 "reply already sent" 이중 응답 오류가 나지 않는다.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // nginx 계열 프록시의 버퍼링 무효화
    });

    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    try {
      if (body.tools.enabled) execution = await executionService(ctx).start(req.auth.orgId, req.auth.userId, sessionId, body.verificationCommand, controller.signal, send);
      if (body.mode) send({ type: "workspace_context", historyCount: savedHistory?.length ?? 0, files: files.map((file) => file.name), excerpted: references.excerpted });
      for await (const event of orchestrator.run({
        orgId: req.auth.orgId,
        userId: req.auth.userId,
        sessionId,
        projectId: session.project_id ?? undefined,
        projectName: session.name ?? undefined,
        // 로컬 UI의 도구는 전용 폴더에만 접근한다. 프로젝트 소스가 기본 작업 폴더가 되면 안 된다.
        projectRoot: body.tools.enabled ? ctx.env.LOCAL_WORKSPACE_ROOT : undefined,
        execution,
        content: body.content,
        savedHistory,
        references: references.chunks,
        mode: body.mode,
        taskClass: body.routing.taskClass,
        model: body.routing.model,
        maxCostUsd: body.routing.maxCostUsd,
        toolsEnabled: body.tools.enabled,
        useRag: body.context.useRag,
        useMemory: body.context.useMemory,
        useLongTermMemory: body.context.useLongTermMemory,
        reasoning: body.routing.reasoning,
        signal: controller.signal,
      })) {
        send(event);
      }
    } catch (err) {
      await execution?.finish(err instanceof Error ? err.message : String(err));
      if (controller.signal.aborted) return;
      // 스트림 도중 에러는 HTTP 상태를 바꿀 수 없다 — 이벤트로 전달하는 것이 유일한 정직한 방법
      const e = err instanceof Error ? err : new Error(String(err));
      req.log.error({ err: e }, "agent stream failed");
      send({ type: "error", code: "stream_failed", message: e.message });
    } finally {
      clearInterval(heartbeat);
      reply.raw.removeListener("close", onClose);
      reply.raw.end();
    }
    } finally { running.delete(sessionId); }
  });

  app.get("/v1/sessions/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await ctx.pool.query(
      `select m.id, m.role, m.content, m.created_at
         from messages m join sessions s on s.id = m.session_id
        where m.session_id = $1 and s.org_id = $2 and s.deleted_at is null
        order by m.created_at, m.id`,
      [id, req.auth.orgId],
    );
    return { messages: rows };
  });
}
