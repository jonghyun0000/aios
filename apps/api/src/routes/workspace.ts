import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { sessionLocks, validateReference } from "../workspace.js";
import { requireRole } from "../auth.js";

const idSchema = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(200);
export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ownedProject = async (id: string, org: string) => {
    const result = await ctx.pool.query("select id from projects where id = $1 and org_id = $2", [id, org]);
    if (!result.rows.length) throw new NotFoundError("project");
  };
  app.post("/v1/sessions", async (req) => {
    requireRole(req.auth, "member");
    const body = z.object({ projectId: idSchema.optional(), title: titleSchema.optional() }).parse(req.body ?? {});
    if (body.projectId) await ownedProject(body.projectId, req.auth.orgId);
    const { rows } = await ctx.pool.query("insert into sessions (org_id, user_id, project_id, title) values ($1,$2,$3,$4) returning id", [req.auth.orgId, req.auth.userId ?? null, body.projectId ?? null, body.title ?? null]);
    return { id: rows[0].id };
  });
  app.get("/v1/sessions", async (req) => {
    const q = z.object({ q: z.string().trim().max(200).default(""), trash: z.enum(["true", "false"]).default("false"), projectId: idSchema.optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query ?? {});
    let cursor: { at: string; id: string } | null = null;
    if (q.cursor) {
      try { cursor = z.object({ at: z.string().datetime({ offset: true }), id: idSchema }).parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString())); }
      catch { throw new ValidationError("대화 목록을 다시 불러와 주세요. 페이지 정보가 올바르지 않습니다."); }
    }
    // strpos는 %와 _도 문자 그대로 검색한다. 제목과 저장된 본문을 같은 권한 범위로 묶는다.
    const { rows } = await ctx.pool.query(
      `select s.id, s.title, s.project_id, p.name as project_name, s.status, s.deleted_at, s.updated_at,
        to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
       from sessions s left join projects p on p.id = s.project_id and p.org_id = s.org_id
       where s.org_id = $1 and (s.deleted_at is not null) = $2 and ($3::uuid is null or s.project_id = $3)
       and ($4 = '' or strpos(lower(coalesce(s.title,'')), lower($4)) > 0 or exists
         (select 1 from messages m where m.session_id = s.id and strpos(lower(coalesce(m.content->>'text','')), lower($4)) > 0))
       and ($5::timestamptz is null or (s.updated_at,s.id) < ($5::timestamptz,$6::uuid))
       order by s.updated_at desc,s.id desc limit $7`, [req.auth.orgId, q.trash === "true", q.projectId ?? null, q.q, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1]);
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { sessions: page.map(({ cursor_at: _, ...row }) => row), nextCursor: more ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString("base64url") : null };
  });
  app.get("/v1/projects", async (req) => ({ projects: (await ctx.pool.query("select id, name from projects where org_id = $1 order by name, id", [req.auth.orgId])).rows }));

  app.get("/v1/sessions/:id/workspace", async (req) => {
    const id = idSchema.parse((req.params as { id: string }).id);
    const { rows } = await ctx.pool.query("select id,title,project_id,deleted_at from sessions where id = $1 and org_id = $2", [id, req.auth.orgId]);
    if (!rows.length) throw new NotFoundError("session");
    const files = await ctx.pool.query(`select id,name,project_id,octet_length(content) as bytes,created_at from workspace_files
      where org_id = $1 and deleted_at is null and (session_id = $2 or project_id = $3) order by created_at,id`, [req.auth.orgId, id, rows[0].project_id]);
    return { session: rows[0], files: rows[0].deleted_at ? [] : files.rows };
  });

  // 변경은 동일 대화 전송과 직렬화한다. 프로젝트 파일 수는 DB 행 잠금으로 다른 대화와도 직렬화한다.
  app.patch("/v1/sessions/:id", async (req, reply) => {
    requireRole(req.auth, "member");
    const id = idSchema.parse((req.params as { id: string }).id);
    const body = z.object({ title: titleSchema.optional(), projectId: idSchema.nullable().optional(), deleted: z.boolean().optional() }).strict().parse(req.body);
    const locks = sessionLocks(ctx);
    if (locks.has(id)) return reply.code(409).send({ error: { code: "session_busy", message: "응답이 끝난 뒤 대화를 변경해 주세요." } });
    locks.add(id);
    try {
      if (body.projectId) await ownedProject(body.projectId, req.auth.orgId);
      const { rows } = await ctx.pool.query(`update sessions set title = coalesce($3,title),
        project_id = case when $4 then $5::uuid else project_id end,
        deleted_at = case when $6::boolean is null then deleted_at when $6 then coalesce(deleted_at,now()) else null end,
        updated_at = now() where id = $1 and org_id = $2 returning id`,
      [id, req.auth.orgId, body.title ?? null, body.projectId !== undefined, body.projectId ?? null, body.deleted ?? null]);
      if (!rows.length) throw new NotFoundError("session");
      return { ok: true };
    } finally { locks.delete(id); }
  });

  app.post("/v1/sessions/:id/files", { bodyLimit: 400_000 }, async (req, reply) => {
    requireRole(req.auth, "member");
    const id = idSchema.parse((req.params as { id: string }).id);
    const body = z.object({ name: z.string().min(1).max(180), content: z.string().max(65536), scope: z.enum(["session", "project"]).default("session") }).parse(req.body);
    validateReference(body.name, body.content);
    const locks = sessionLocks(ctx);
    if (locks.has(id)) return reply.code(409).send({ error: { code: "session_busy", message: "응답이 끝난 뒤 파일을 연결해 주세요." } });
    locks.add(id);
    const client = await ctx.pool.connect().catch((err) => { locks.delete(id); throw err; });
    try {
      await client.query("begin");
      const { rows } = await client.query("select project_id from sessions where id = $1 and org_id = $2 and deleted_at is null for update", [id, req.auth.orgId]);
      if (!rows.length) throw new NotFoundError("session");
      const project = body.scope === "project" ? rows[0].project_id as string | null : null;
      if (body.scope === "project" && !project) throw new ValidationError("먼저 프로젝트를 연결해 주세요.");
      if (project) await client.query("select id from projects where id = $1 and org_id = $2 for update", [project, req.auth.orgId]);
      const count = await client.query(`select count(*)::int as n from workspace_files where org_id = $1 and deleted_at is null and ${project ? "project_id" : "session_id"} = $2`, [req.auth.orgId, project ?? id]);
      if (count.rows[0].n >= 8) throw new ValidationError("대화·프로젝트마다 최대 8개 파일을 연결할 수 있습니다. 기존 연결을 해제해 주세요.");
      const result = await client.query("insert into workspace_files (org_id, session_id, project_id, name, content) values ($1,$2,$3,$4,$5) returning id", [req.auth.orgId, project ? null : id, project, body.name, body.content]);
      await client.query("commit");
      return { id: result.rows[0].id };
    } catch (err) { await client.query("rollback"); throw err; }
    finally { client.release(); locks.delete(id); }
  });

  app.delete("/v1/sessions/:id/files/:fileId", async (req, reply) => {
    requireRole(req.auth, "member");
    const { id, fileId } = z.object({ id: idSchema, fileId: idSchema }).parse(req.params);
    const locks = sessionLocks(ctx);
    if (locks.has(id)) return reply.code(409).send({ error: { code: "session_busy", message: "응답이 끝난 뒤 파일 연결을 해제해 주세요." } });
    locks.add(id);
    try {
      const result = await ctx.pool.query(`update workspace_files f set deleted_at = now() from sessions s
        where s.id = $1 and s.org_id = $2 and s.deleted_at is null and f.id = $3 and f.org_id = s.org_id
        and f.deleted_at is null and (f.session_id = s.id or f.project_id = s.project_id) returning f.id`, [id, req.auth.orgId, fileId]);
      if (!result.rows.length) throw new NotFoundError("file");
      return { ok: true };
    } finally { locks.delete(id); }
  });
}
