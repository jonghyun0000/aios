import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AiosError } from "@aios/shared";
import { safeJailPath } from "@aios/tools";

const LIMIT = 1024 * 1024;
export const hash = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
export interface Checkpoint { path: string; before: string | null; beforeHash: string | null; after: string; afterHash: string; mode: number }
export const conflict = () => new AiosError("file_conflict", "파일이 승인 화면 또는 저장 시점 이후 변경됐습니다. 현재 내용을 보존하기 위해 작업을 중단했습니다.", { status: 409 });

export async function readState(root: string, path: string): Promise<{ content: Buffer; mode: number } | null> {
  const target = await safeJailPath(root, path);
  const stat = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > LIMIT) throw new Error("복구 가능한 일반 파일(최대 1 MiB)만 수정할 수 있습니다.");
  const content = await readFile(target);
  if (content.length > LIMIT) throw new Error("파일 크기 제한을 초과했습니다.");
  return { content, mode: stat.mode & 0o777 };
}

/** 백업은 모델이 접근할 수 없는 작업 폴더 바깥에 저장한다. fsync 완료 전에는 실행하지 않는다. */
export async function saveCheckpoint(store: string, id: string, cp: Checkpoint): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = await open(join(store, `${id}.json`), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(cp)); await file.sync(); } finally { await file.close(); }
}
export async function loadCheckpoint(store: string, id: string): Promise<Checkpoint> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid checkpoint id");
  const cp = JSON.parse(await readFile(join(store, `${id}.json`), "utf8")) as Checkpoint;
  if (hash(cp.after) !== cp.afterHash || (cp.before !== null && hash(Buffer.from(cp.before, "base64")) !== cp.beforeHash)) throw new Error("체크포인트 무결성 확인 실패");
  return cp;
}
export async function prepareCheckpoint(root: string, path: string, after: string): Promise<Checkpoint> {
  if (Buffer.byteLength(after) > 65536) throw new Error("승인 가능한 텍스트 파일은 최대 64 KiB입니다.");
  const before = await readState(root, path);
  if (before && (before.content.length > 65536 || !Buffer.from(before.content.toString("utf8")).equals(before.content) || before.content.includes(0))) throw new Error("최대 64 KiB의 UTF-8 텍스트 파일만 수정할 수 있습니다.");
  return { path, before: before?.content.toString("base64") ?? null, beforeHash: before ? hash(before.content) : null, after, afterHash: hash(after), mode: before?.mode ?? 0o644 };
}
export async function assertState(root: string, cp: Checkpoint, expected: string | null): Promise<void> {
  const state = await readState(root, cp.path);
  if ((state ? hash(state.content) : null) !== expected) throw conflict();
}
export async function restoreCheckpoint(root: string, cp: Checkpoint, resume = false): Promise<{ alreadyRestored: boolean }> {
  // 복구 의도가 DB에 먼저 남은 요청만 중간 종료를 재개한다. 단순 원본 해시 일치를 최초 복구 성공으로 오인하지 않는다.
  if (resume) {
    const current = await readState(root, cp.path);
    if ((current ? hash(current.content) : null) === cp.beforeHash) return { alreadyRestored: true };
  }
  await assertState(root, cp, cp.afterHash);
  const target = await safeJailPath(root, cp.path);
  if (cp.before === null) { await unlink(target); await assertState(root, cp, null); return { alreadyRestored: false }; }
  const temp = join(dirname(target), `.aios-restore-${randomUUID()}`);
  const file = await open(temp, "wx", cp.mode);
  try {
    await file.writeFile(Buffer.from(cp.before, "base64")); await file.sync(); await file.close();
    await assertState(root, cp, cp.afterHash);
    await rename(temp, target);
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  await assertState(root, cp, cp.beforeHash);
  return { alreadyRestored: false };
}
