import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const canonical = (path: string) => path.normalize("NFC");
interface Owner { version: 1; workspace: string; host: string; pid: number; startedAt: string; token: string }
export class LocalApiOwnershipError extends Error {
  readonly code: "local_api_busy" | "local_api_lock_unknown" | "local_api_maintenance";
  constructor(code: "local_api_busy" | "local_api_lock_unknown" | "local_api_maintenance") {
    super(code === "local_api_busy"
      ? "이 작업 폴더의 API가 이미 실행 중입니다. 다른 포트·DB로 중복 실행하지 말고 기존 AIOS 상태를 확인하세요. 지원 구성은 단일 로컬 API이며 다른 workspace의 API와 같은 DB를 공유하는 구성도 미지원입니다."
      : code === "local_api_maintenance" ? "백업·복원 검사 유지보수 중에는 API를 시작하지 않습니다. 유지보수 종료 상태를 확인하세요."
        : "API 소유권 잠금을 안전하게 확인하지 못했습니다. docs/26-durable-execution.md의 잠금 진단 절차를 확인하세요. 자동 삭제·강제 종료하지 않았습니다.");
    this.code = code;
  }
}
const unknown = () => new LocalApiOwnershipError("local_api_lock_unknown");

async function noLinkedParents(path: string): Promise<void> {
  let current = path;
  while (true) {
    const stat = await lstat(current).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw unknown(); });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw unknown();
    if (current === dirname(current)) return;
    current = dirname(current);
  }
}

/** PID만 같다고 같은 API는 아니다. 조회 실패/권한 거부는 죽은 프로세스로 추정하지 않는다. */
export async function processStart(pid: number): Promise<string | null> {
  try { process.kill(pid, 0); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") return null; throw unknown(); }
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2500, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } });
    const start = stdout.trim();
    if (!start) throw unknown();
    return start;
  } catch {
    // 조회 사이에 정상 종료됐을 때만 재확인하여 회수한다.
    try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") return null; }
    throw unknown();
  }
}

async function readOwner(path: string): Promise<Owner> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 8192) throw unknown();
    const value = JSON.parse(await readFile(path, "utf8")) as Owner;
    if (value.version !== 1 || typeof value.workspace !== "string" || typeof value.host !== "string" || !Number.isSafeInteger(value.pid) || value.pid < 2 ||
      typeof value.startedAt !== "string" || !value.startedAt || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/.test(value.token)) throw unknown();
    return value;
  } catch { throw unknown(); }
}

export async function apiOwnershipPath(workspace: string): Promise<{ workspace: string; path: string }> {
  const root = await realpath(workspace);
  // 포트·DB URL·소스 checkout과 무관한 실제 작업 폴더 하나의 잠금이다. 모델 작업 폴더 밖에 둔다.
  const key = createHash("sha256").update(canonical(root)).digest("hex");
  return { workspace: canonical(root), path: join(dirname(dirname(root)), "run", "local-api", `${key}.lock`) };
}

export async function acquireLocalApiOwnership(workspace: string): Promise<{ path: string; release(): Promise<void> }> {
  const location = await apiOwnershipPath(workspace);
  const startedAt = await processStart(process.pid);
  if (!startedAt) throw unknown();
  const owner: Owner = { version: 1, workspace: location.workspace, host: hostname(), pid: process.pid, startedAt, token: randomUUID() };
  await noLinkedParents(dirname(location.path));
  await mkdir(dirname(location.path), { recursive: true, mode: 0o700 });
  await noLinkedParents(dirname(location.path));
  const write = async () => {
    const handle = await open(location.path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
  };
  try { await write(); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw unknown();
    // 회수끼리의 경쟁을 직렬화한다. 회수 중 비정상 종료로 남은 디렉터리도 임의 삭제하지 않는다.
    const recovery = `${location.path}.recovery`;
    try { await mkdir(recovery); } catch { throw unknown(); }
    try {
      const previous = await readOwner(location.path);
      if (previous.workspace !== owner.workspace || previous.host !== owner.host) throw unknown();
      const liveStart = await processStart(previous.pid);
      if (liveStart === previous.startedAt) throw new LocalApiOwnershipError("local_api_busy");
      // ESRCH 또는 PID 재사용을 실제 확인했다. 시간 만료만으로 살아 있는 잠금을 훔치지 않는다.
      await unlink(location.path);
      try { await write(); } catch { throw new LocalApiOwnershipError("local_api_busy"); }
    } finally { await rmdir(recovery); }
  }
  let released = false;
  const lease = { path: location.path, async release() {
    if (released) return;
    await noLinkedParents(dirname(location.path));
    const current = await readOwner(location.path);
    if (current.token !== owner.token || current.pid !== owner.pid || current.startedAt !== owner.startedAt || current.workspace !== owner.workspace || current.host !== owner.host) throw unknown();
    await unlink(location.path); released = true;
  } };
  // 백업 측도 maintenance 선점 뒤 이 API 잠금을 검사한다. 양쪽이 서로 확인해야 직접 기동 경합도 실패 폐쇄된다.
  const maintenance = join(dirname(dirname(location.path)), "local-app", "maintenance.lock");
  try {
    await noLinkedParents(dirname(maintenance));
    const present = await lstat(maintenance).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (present) throw new LocalApiOwnershipError("local_api_maintenance");
  } catch (err) { await lease.release(); throw err instanceof LocalApiOwnershipError ? err : unknown(); }
  return lease;
}
