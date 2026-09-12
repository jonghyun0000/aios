import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { requireRole } from "../auth.js";
import { enqueueIndexJob } from "../queue.js";
import { registerWorkspaceRoutes } from "./workspace.js";

/** 세션/프로젝트/검색/메모리/모델/사용량/빌링 — CRUD성 라우트 모음 */
export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerWorkspaceRoutes(app, ctx);

  // --- projects & indexing ---
  app.post("/v1/projects", async (req) => {
    requireRole(req.auth, "admin");
    const body = z.object({ name: z.string().trim().min(1).max(200), repoUrl: z.string().url().optional() }).parse(req.body);
    const { rows } = await ctx.pool.query<{ id: string }>(
      `insert into projects (org_id, name, repo_url) values ($1, $2, $3) returning id`,
      [req.auth.orgId, body.name, body.repoUrl ?? null],
    );
    return { id: rows[0]!.id };
  });

  app.post("/v1/projects/:id/index", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ rootDir: z.string() }).parse(req.body);
    const owned = await ctx.pool.query(`select 1 from projects where id = $1 and org_id = $2`, [id, req.auth.orgId]);
    if (owned.rowCount === 0) throw new NotFoundError("project");
    const jobId = await enqueueIndexJob(ctx, { projectId: id, rootDir: body.rootDir, orgId: req.auth.orgId });
    return reply.status(202).send({ jobId });
  });

  app.get("/v1/projects/:id/search", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ q: z.string().min(1), k: z.coerce.number().max(30).default(8) }).parse(req.query);
    const owned = await ctx.pool.query(`select 1 from projects where id = $1 and org_id = $2`, [id, req.auth.orgId]);
    if (owned.rowCount === 0) throw new NotFoundError("project");
    return { hits: await ctx.retriever.retrieve(id, q.q, q.k) };
  });

  // --- memory ---
  app.get("/v1/memory", async (req) => {
    const q = z.object({ q: z.string().min(1), projectId: z.string().uuid().optional() }).parse(req.query);
    const items = await ctx.memory.ltm.recall(
      { orgId: req.auth.orgId, userId: req.auth.userId, projectId: q.projectId },
      q.q,
    );
    return { items };
  });

  app.post("/v1/memory", async (req) => {
    const body = z
      .object({
        kind: z.enum(["fact", "preference", "decision"]),
        content: z.string().min(1).max(4000),
        projectId: z.string().uuid().optional(),
        importance: z.number().min(0).max(1).default(0.7),
      })
      .parse(req.body);
    return await ctx.memory.ltm.remember(
      { orgId: req.auth.orgId, userId: req.auth.userId, projectId: body.projectId },
      body,
    );
  });

  app.delete("/v1/memory/:id", async (req) => {
    const { id } = req.params as { id: string };
    const deleted = await ctx.memory.ltm.forget(id, req.auth.orgId);
    if (!deleted) throw new NotFoundError("memory item");
    return { ok: true };
  });

  // --- models / usage ---
  app.get("/v1/models", async () => ({ models: ctx.router.snapshot() }));

  app.get("/v1/usage", async (req) => {
    requireRole(req.auth, "admin");
    const { rows } = await ctx.pool.query(
      `select date_trunc('day', created_at) as day, provider, model,
              sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cost_usd) as cost_usd
         from usage_events
        where org_id = $1 and created_at > now() - interval '30 days'
        group by 1, 2, 3 order by 1 desc`,
      [req.auth.orgId],
    );
    return { usage: rows };
  });

  // billing 라우트는 routes/billing.ts 로 분리했다 —
  // Checkout/포털/해지/웹훅이 한 덩어리라 core의 CRUD와 섞을 이유가 없다.

  // --- me ---
  app.get("/v1/me", async (req) => ({
    orgId: req.auth.orgId,
    userId: req.auth.userId ?? null,
    role: req.auth.role,
    via: req.auth.via,
    ...(req.auth.via === "local" ? { workspaceRoot: ctx.env.LOCAL_WORKSPACE_ROOT ?? null } : {}),
    requestId: randomUUID(),
  }));
}
