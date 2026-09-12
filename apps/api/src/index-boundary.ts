import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AiosError, ForbiddenError, NotFoundError } from "@aios/shared";
import { safeJailPath } from "@aios/tools";
import type { ProgressFn } from "@aios/indexer";
import type { AppContext } from "./context.js";
import type { IndexJobData } from "./queue.js";

const denied = () => new ForbiddenError("지정된 로컬 작업 폴더 안의 일반 경로만 색인할 수 있습니다.");

/** HTTP 접수와 실제 큐 실행 모두 검사한다. DB 조직 격리만으로 호스트 파일이 격리되지는 않는다. */
export async function validateIndexRoot(ctx: AppContext, projectId: string, orgId: string, requested: string): Promise<string> {
  const configured = ctx.env.LOCAL_WORKSPACE_ROOT;
  if (!configured || !isAbsolute(configured)) throw new AiosError("workspace_required", "색인용 로컬 작업 폴더가 설정되지 않았습니다.", { status: 409 });
  const project = await ctx.pool.query("select id from projects where id=$1 and org_id=$2", [projectId, orgId]);
  if (!project.rows.length) throw new NotFoundError("project");
  // 실행·복구 서비스와 같은 로컬 조직 매핑. 다른 조직은 이 호스트 폴더를 사용할 수 없다.
  const owner = await ctx.pool.query("select id from organizations where slug=$1", [ctx.env.LOCAL_NO_AUTH_ORG_SLUG]);
  if (!owner.rows[0]?.id || owner.rows[0].id !== orgId) throw new ForbiddenError("이 로컬 작업 폴더는 다른 조직에서 사용할 수 없습니다.");
  if (typeof requested !== "string" || !isAbsolute(requested)) throw denied();
  try {
    const root = await safeJailPath(configured, requested);
    if (!(await lstat(root)).isDirectory()) throw denied();
    return root;
  } catch { throw denied(); }
}

/** 워커가 오래된/조작된 잡을 처리해도 HTTP 검사만 믿지 않고 파일 읽기 직전까지 경계를 강제한다. */
export async function runIndexJob(ctx: AppContext, data: IndexJobData, onProgress?: ProgressFn) {
  const root = await validateIndexRoot(ctx, data.projectId, data.orgId, data.rootDir);
  return ctx.indexer.indexProject(data.projectId, root, onProgress, async (file) => {
    try { await safeJailPath(root, file); } catch { throw denied(); }
  });
}
