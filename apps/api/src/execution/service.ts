import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { AiosError, NotFoundError, type ToolCall } from "@aios/shared";
import type { ToolResult } from "@aios/tools";
import type { AppContext } from "../context.js";
import { assertState, loadCheckpoint, prepareCheckpoint, restoreCheckpoint, saveCheckpoint, type Checkpoint } from "./checkpoints.js";

const services = new WeakMap<AppContext, ExecutionService>();
const workspaceLocks = new Set<string>();
export function executionService(ctx: AppContext): ExecutionService {
  let service = services.get(ctx);
  if (!service) { service = new ExecutionService(ctx); services.set(ctx, service); }
  return service;
}
type Notice = (event: { type: "execution_update"; runId: string }) => void;
const busy = () => new AiosError("workspace_busy", "다른 실행이 이 작업 폴더를 사용 중입니다. 승인·실행·복구가 끝난 뒤 다시 시도해 주세요.", { status: 409 });

/** 로컬 단일 API 프로세스용. 재시작 시 승인을 재사용하지 않는다. */
export class ExecutionService {
  readonly active = new Map<string, ExecutionRun>();
  readonly pending = new Map<string, { run: ExecutionRun; settle(value: boolean): boolean }>();
  private workspaceOrg?: Promise<string | undefined>;
  readonly root: string;
  readonly store: string;
  constructor(readonly ctx: AppContext, readonly approvalMs = 5 * 60_000, store?: string) {
    this.root = resolve(ctx.env.LOCAL_WORKSPACE_ROOT || ".");
    this.store = store ?? resolve(dirname(this.root), "..", "checkpoints", "stage3");
  }
  async withWorkspace<T>(work: () => Promise<T>): Promise<T> {
    const key = this.root.normalize("NFC");
    // 같은 프로세스에서 컨텍스트를 두 번 조립해도 별도 잠금을 얻지 못한다. 프로세스 간 배제는 main의 소유권 잠금이다.
    if (workspaceLocks.has(key)) throw busy();
    workspaceLocks.add(key);
    try { return await work(); } finally { workspaceLocks.delete(key); }
  }
  async assertOrg(orgId: string): Promise<void> {
    // 전용 호스트 폴더는 로컬 조직 하나의 자원이다. DB 행 격리만으로 파일 격리가 되지는 않는다.
    this.workspaceOrg ??= this.ctx.pool.query("select id from organizations where slug=$1", [this.ctx.env.LOCAL_NO_AUTH_ORG_SLUG])
      .then(({ rows }) => rows[0]?.id as string | undefined).catch((err) => { this.workspaceOrg = undefined; throw err; });
    if (await this.workspaceOrg !== orgId) throw new AiosError("workspace_forbidden", "이 로컬 작업 폴더는 다른 조직에서 사용할 수 없습니다.", { status: 403 });
  }
  async start(orgId: string, userId: string | undefined, sessionId: string, command: string | undefined, signal: AbortSignal, notify: Notice): Promise<ExecutionRun> {
    if (!this.ctx.env.LOCAL_WORKSPACE_ROOT) throw new AiosError("workspace_required", "승인·복구용 로컬 작업 폴더가 설정되지 않았습니다. 도구를 끄거나 LOCAL_WORKSPACE_ROOT를 설정해 주세요.", { status: 409 });
    await this.assertOrg(orgId);
    const id = randomUUID();
    const run = new ExecutionRun(this, id, orgId, userId, sessionId, signal, notify, command);
    this.active.set(id, run);
    try { await this.ctx.pool.query("insert into execution_runs (id,org_id,session_id,workspace_root,verification_command) values ($1,$2,$3,$4,$5)", [id, orgId, sessionId, this.root, command ?? null]); }
    catch (err) { this.active.delete(id); throw err; }
    run.notify(); return run;
  }
  async list(orgId: string, sessionId: string) {
    const owner = await this.ctx.pool.query("select id from sessions where id=$1 and org_id=$2 and deleted_at is null", [sessionId, orgId]);
    if (!owner.rows.length) throw new NotFoundError("session");
    const { rows } = await this.ctx.pool.query("select * from execution_runs where session_id=$1 and org_id=$2 order by created_at desc limit 20", [sessionId, orgId]);
    for (const run of rows) {
      if (run.status === "running" && !this.active.has(run.id)) {
        await this.ctx.pool.query(`with interrupted as (
          update execution_runs set status='interrupted',summary='서버 재시작으로 실행 확인이 끊겼습니다. 변경 내역을 확인해 주세요.',finished_at=now()
          where id=$1 and status='running' returning id
        ) update execution_actions set status='interrupted',finished_at=now()
          where run_id in (select id from interrupted) and status in ('pending','approved','running')`, [run.id]);
        run.status = "interrupted"; run.summary = "서버 재시작으로 실행 확인이 끊겼습니다. 변경 내역을 확인해 주세요.";
      }
      // 경로·백업 내용은 모델 텍스트가 아닌 서버 기록이다. 파일 본문은 승인 미리보기만 반환한다.
      run.actions = (await this.ctx.pool.query("select id,run_id,tool_name,arguments - 'content' as arguments,purpose,status,output,exit_code,before_hash,after_hash,preview,checkpoint,expires_at,decided_at,restored_at,created_at,finished_at from execution_actions where run_id=$1 order by created_at,id", [run.id])).rows;
    }
    return { runs: rows };
  }
  async decide(orgId: string, sessionId: string, id: string, approve: boolean, actor?: string) {
    const pending = this.pending.get(id);
    if (!pending || pending.run.orgId !== orgId || pending.run.sessionId !== sessionId) throw new NotFoundError("pending approval");
    pending.run.signal.throwIfAborted();
    const result = await this.ctx.pool.query(`update execution_actions set status=$2,decided_by=$3,decided_at=now(),finished_at=case when $2='rejected' then now() else null end
      where id=$1 and status='pending' and expires_at>now() returning id`, [id, approve ? "approved" : "rejected", actor ?? null]);
    if (!result.rows.length) throw new AiosError("approval_expired", "이미 처리됐거나 만료된 승인입니다.", { status: 409 });
    if (!pending.settle(approve)) {
      await this.ctx.pool.query("update execution_actions set status='expired',finished_at=now() where id=$1 and status='approved'", [id]);
      throw new AiosError("approval_expired", "승인 대기가 이미 끝났습니다. 실행하지 않았습니다.", { status: 409 });
    }
    pending.run.notify();
    return { ok: true };
  }
  async restore(orgId: string, sessionId: string, id: string) {
    await this.assertOrg(orgId);
    return this.withWorkspace(async () => {
      const { rows } = await this.ctx.pool.query(`select a.*,r.workspace_root from execution_actions a join execution_runs r on r.id=a.run_id
        join sessions s on s.id=r.session_id where a.id=$1 and r.org_id=$2 and s.org_id=$2 and r.session_id=$3 and s.deleted_at is null`, [id, orgId, sessionId]);
      const row = rows[0];
      if (!row) throw new NotFoundError("checkpoint");
      if (resolve(row.workspace_root).normalize("NFC") !== this.root.normalize("NFC") || !row.checkpoint || !row.decided_at || ["pending", "approved", "running", "rejected", "expired"].includes(row.status)) throw new AiosError("restore_unavailable", "복구할 수 있는 변경이 아닙니다.", { status: 409 });
      const cp = await loadCheckpoint(this.store, id);
      if (cp.afterHash !== row.after_hash || cp.beforeHash !== row.before_hash || cp.path !== row.arguments.path) throw new Error("체크포인트 기록 불일치");
      if (row.restored_at) {
        // 응답만 유실된 복구 재요청은 파일을 다시 쓰지 않는다. 이후 수동 변경은 그대로 충돌로 보존한다.
        if (row.status !== "restored") throw new AiosError("restore_unavailable", "복구 기록을 확인해야 합니다.", { status: 409 });
        await assertState(this.root, cp, cp.beforeHash);
        return { ok: true, removedNewFile: cp.before === null, alreadyRestored: true };
      }
      // 복구 의도를 먼저 남긴다. 실제 상태 확인 없이 복구 완료로 기록하지 않는다.
      const intent = await this.ctx.pool.query("update execution_actions set status='restoring' where id=$1 and status=$2 and restored_at is null returning id", [id, row.status]);
      if (!intent.rows.length) throw busy();
      try {
        const result = await restoreCheckpoint(this.root, cp, row.status === "restoring");
        // 하나의 SQL 문으로 action/run을 함께 기록한다. 중간 DB 장애가 파일 성공/기록 성공을 갈라놓지 않게 한다.
        const saved = await this.ctx.pool.query(`with restored_action as (
          update execution_actions set status='restored',restored_at=now() where id=$1 and status='restoring' returning run_id
        ) update execution_runs set status='restored',summary='파일 변경을 복구했습니다. 이전 검증은 복구 전 상태의 결과이므로 다시 검증해 주세요.'
          where id in (select run_id from restored_action) returning id`, [id]);
        if (!saved.rows.length) throw new Error("복구 기록 저장 실패");
        return { ok: true, removedNewFile: cp.before === null, ...result };
      } catch (err) {
        if (err instanceof AiosError && err.code === "file_conflict") {
          await this.ctx.pool.query("update execution_actions set status='restore_conflict' where id=$1 and status='restoring'", [id]);
          throw err;
        }
        // 파일 조작/DB 응답이 불확실하면 의도를 지우지 않는다. 다음 명시적 재시도가 해시를 확인하여 재개한다.
        throw new AiosError("restore_incomplete", "복구 기록 확인이 끝나지 않았습니다. 파일을 임의로 덮어쓰지 말고 같은 변경의 복구를 다시 요청해 주세요.", { status: 503 });
      }
    });
  }
}

export class ExecutionRun {
  halted = false;
  private failures = false;
  private actions = 0;
  private writes = 0;
  private verification: boolean | undefined;
  private finished = false;
  constructor(readonly service: ExecutionService, readonly id: string, readonly orgId: string, readonly userId: string | undefined,
    readonly sessionId: string, readonly signal: AbortSignal, private emit: Notice, readonly command?: string) {}
  notify() { if (!this.signal.aborted) this.emit({ type: "execution_update", runId: this.id }); }
  async execute(original: ToolCall, purpose = "tool"): Promise<ToolResult> {
    this.signal.throwIfAborted();
    const call: ToolCall = structuredClone(original); // 승인 이후 호출자가 인자를 바꿀 수 없다.
    const { ctx } = this.service;
    const def = ctx.tools.get(call.name);
    const parsed = def?.schema.safeParse(call.arguments);
    if (!def || !parsed?.success) {
      this.failures = true;
      const output = "도구 이름 또는 인자가 올바르지 않습니다.";
      await ctx.pool.query("insert into execution_actions (id,run_id,tool_name,arguments,purpose,status,output,finished_at) values ($1,$2,$3,$4,$5,'failed',$6,now())", [randomUUID(), this.id, call.name, JSON.stringify(call.arguments), purpose, output]);
      this.notify(); return { ok: false, output };
    }
    call.arguments = parsed.data;
    const risky = def.permission !== "read";
    const id = randomUUID();
    this.actions++;
    await ctx.pool.query("insert into execution_actions (id,run_id,tool_name,arguments,purpose,status) values ($1,$2,$3,$4,$5,'running')", [id, this.id, call.name, JSON.stringify(call.arguments), purpose]);
    const work = async (): Promise<ToolResult> => {
      let cp: Checkpoint | undefined;
      if (risky) {
        if (call.name !== "write_file" && call.name !== "run_command") throw new Error("이 변경 도구는 안전 실행을 지원하지 않습니다.");
        if (call.name === "write_file") {
          cp = await prepareCheckpoint(this.service.root, String(call.arguments.path), String(call.arguments.content));
          await saveCheckpoint(this.service.store, id, cp);
        }
        const preview = cp ? { before: cp.before === null ? null : Buffer.from(cp.before, "base64").toString("utf8"), after: cp.after } : null;
        await ctx.pool.query(`update execution_actions set status='pending',checkpoint=$2,before_hash=$3,after_hash=$4,preview=$5,expires_at=$6 where id=$1`, [id, !!cp, cp?.beforeHash ?? null, cp?.afterHash ?? null, preview ? JSON.stringify(preview) : null, new Date(Date.now() + this.service.approvalMs)]);
        const approved = await this.waitForApproval(id);
        this.signal.throwIfAborted();
        if (!approved) { this.failures = true; this.halted = true; return { ok: false, output: "사용자가 거절했거나 승인이 만료됐습니다. 같은 작업을 다시 요청하지 말고 중단하세요." }; }
        if (cp) await assertState(this.service.root, cp, cp.beforeHash);
      }
      this.signal.throwIfAborted();
      await ctx.pool.query("update execution_actions set status='running' where id=$1", [id]); this.notify();
      const result = await ctx.executor.execute({ orgId: this.orgId, userId: this.userId, sessionId: this.sessionId, projectRoot: this.service.root }, call, this.signal, async () => true);
      if (cp && result.ok) { await assertState(this.service.root, cp, cp.afterHash); this.writes++; }
      await ctx.pool.query("update execution_actions set status=$2,output=$3,exit_code=$4,finished_at=now() where id=$1", [id, result.ok ? "passed" : "failed", result.output, result.exitCode ?? null]);
      if (!result.ok) this.failures = true;
      return result;
    };
    try { return await (risky ? this.service.withWorkspace(work) : work()); }
    catch (err) {
      this.failures = true;
      const output = err instanceof Error ? err.message : String(err);
      await ctx.pool.query("update execution_actions set status=$2,output=$3,finished_at=now() where id=$1 and status not in ('rejected','expired')", [id, this.signal.aborted ? "cancelled" : "failed", output]);
      this.signal.throwIfAborted();
      return { ok: false, output };
    } finally { this.notify(); }
  }
  private async waitForApproval(id: string): Promise<boolean> {
    let settle!: (value: boolean) => boolean;
    let settled = false;
    const decision = new Promise<boolean>((resolveDecision) => { settle = (value) => { if (settled) return false; settled = true; resolveDecision(value); return true; }; });
    this.service.pending.set(id, { run: this, settle });
    const onAbort = () => settle(false);
    this.signal.addEventListener("abort", onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    const timer = setTimeout(() => settle(false), this.service.approvalMs);
    this.notify();
    try {
      const approved = await decision;
      if (!approved) await this.service.ctx.pool.query("update execution_actions set status=$2,finished_at=now() where id=$1 and status in ('pending','approved')", [id, this.signal.aborted ? "cancelled" : "expired"]);
      return approved;
    } finally { clearTimeout(timer); this.signal.removeEventListener("abort", onAbort); this.service.pending.delete(id); }
  }
  async verify(): Promise<void> {
    if (!this.command || this.halted) return;
    const result = await this.execute({ id: randomUUID(), name: "run_command", arguments: { command: this.command, cwd: "." } }, "verification");
    this.verification = result.ok && result.exitCode === 0;
  }
  async finish(error?: string): Promise<void> {
    if (this.finished) return;
    const status = this.signal.aborted ? "cancelled" : error ? "failed" : this.failures ? "failed" : this.verification === true ? "verified" : "unverified";
    const summary = this.signal.aborted ? "실행을 중단했습니다. 이미 저장된 파일은 변경 기록에서 확인·복구하세요."
      : error ?? (this.failures ? "실패·거절·만료된 작업이 있습니다. 실행 기록을 확인하세요."
        : this.verification ? "지정한 검증 명령의 종료 코드 0을 확인했습니다. 전체 요구사항의 정확성을 보증하지는 않습니다."
        : this.writes ? `${this.writes}개 파일 저장·내용 해시 확인. 동작 검증은 아직 하지 않았습니다.`
        : this.actions ? "도구 결과를 기록했습니다. 별도의 검증 명령은 실행하지 않았습니다." : "AI가 답변만 생성했습니다. 실제 실행·검증 기록은 없습니다.");
    try { await this.service.ctx.pool.query("update execution_runs set status=$2,summary=$3,finished_at=now() where id=$1", [this.id, status, summary]); this.finished = true; }
    finally { this.service.active.delete(this.id); this.notify(); }
  }
}
