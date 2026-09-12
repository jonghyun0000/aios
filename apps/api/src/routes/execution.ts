import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { executionService } from "../execution/service.js";
import { requireRole } from "../auth.js";
import { sessionLocks } from "../workspace.js";

const ids = z.object({ id: z.string().uuid(), actionId: z.string().uuid().optional() });
export function registerExecutionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/sessions/:id/executions", async (req) => {
    const { id } = ids.parse(req.params);
    return executionService(ctx).list(req.auth.orgId, id);
  });
  app.post("/v1/sessions/:id/executions/:actionId/approval", async (req) => {
    requireRole(req.auth, "member");
    const { id, actionId } = ids.parse(req.params);
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    return executionService(ctx).decide(req.auth.orgId, id, actionId!, approve, req.auth.userId);
  });
  app.post("/v1/sessions/:id/executions/:actionId/restore", async (req, reply) => {
    requireRole(req.auth, "member");
    const { id, actionId } = ids.parse(req.params);
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    const locks = sessionLocks(ctx);
    if (locks.has(id)) return reply.code(409).send({ error: { code: "session_busy", message: "응답을 중단하거나 끝낸 뒤 복구해 주세요." } });
    locks.add(id);
    try { return await executionService(ctx).restore(req.auth.orgId, id, actionId!); }
    finally { locks.delete(id); }
  });
}
