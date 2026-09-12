import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ForbiddenError } from "@aios/shared";
import type { AppContext } from "../context.js";

const STATUS_PATH = "/Volumes/T7/bigdata/operations/backup-status.json";
const BACKUP_ROOT = "/Volumes/T7/bigdata/backups/local";
const idSchema = z.string().regex(/^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/);
const timestamp = z.string().datetime().refine((value) => Date.parse(value) <= Date.now() + 300_000);
const restoreSchema = z.object({
  backupId: idSchema,
  checkedAt: timestamp,
  status: z.enum(["passed", "failed"]),
  restoredDatabase: z.string().regex(/^aios_restore_[a-z0-9_]+$/).max(63).optional(),
  files: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine((value) => value.status !== "passed" || (value.restoredDatabase !== undefined && value.files !== undefined));
const statusSchema = z.object({
  version: z.literal(1),
  lastBackup: z.object({
    id: idSchema,
    createdAt: timestamp,
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    manifestPath: z.string().max(1024),
  }).strict().optional(),
  lastRestoreCheck: restoreSchema.optional(),
}).strict();

type StatusRecord = z.infer<typeof statusSchema>;
export type OperationsHistory = {
  state: "empty" | "recorded" | "invalid" | "unavailable";
  message?: string;
  lastBackup?: Omit<NonNullable<StatusRecord["lastBackup"]>, "manifestPath">;
  lastRestoreCheck?: StatusRecord["lastRestoreCheck"];
};

async function hasManifest(backupRoot: string, id: string): Promise<boolean> {
  const path = join(backupRoot, id, "manifest.json");
  try {
    // 허용된 이름이어도 상위 폴더가 심볼릭 링크이면 외부 파일을 근거로 삼지 않는다.
    const actual = await realpath(path);
    const stat = await lstat(path);
    return actual === resolve(path) && stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024;
  } catch { return false; }
}

/** 파일 경로는 서버에서 고정한다. 테스트만 격리된 T7 폴더를 전달한다. */
export async function readOperationsHistory(statusPath = STATUS_PATH, backupRoot = BACKUP_ROOT): Promise<OperationsHistory> {
  let text: string;
  try {
    const handle = await open(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * 1024) return { state: "invalid", message: "운영 기록의 크기 또는 파일 형식이 올바르지 않습니다." };
      // 읽는 동안 커진 파일도 제한한다. 손상된 운영 기록을 무제한으로 읽지 않는다.
      const bytes = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16 * 1024) return { state: "invalid", message: "운영 기록의 크기가 허용 범위를 벗어났습니다." };
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "empty" };
    return { state: "unavailable", message: "운영 기록을 읽을 수 없습니다. T7 연결과 파일 접근 권한을 확인하세요." };
  }
  let data: StatusRecord;
  try { data = statusSchema.parse(JSON.parse(text)); }
  catch { return { state: "invalid", message: "운영 기록이 손상되었거나 필수 검증 정보가 없습니다. 상태 확인 명령으로 점검하세요." }; }
  if (!data.lastBackup && !data.lastRestoreCheck) return { state: "empty" };
  if (data.lastBackup && (
    data.lastBackup.manifestPath !== join(backupRoot, data.lastBackup.id, "manifest.json") ||
    !await hasManifest(backupRoot, data.lastBackup.id)
  )) return { state: "invalid", message: "기록이 가리키는 백업 파일을 확인할 수 없습니다. 백업 경로를 점검하세요." };
  if (data.lastRestoreCheck && !await hasManifest(backupRoot, data.lastRestoreCheck.backupId)) {
    return { state: "invalid", message: "복원 검사 기록의 원본 백업을 확인할 수 없습니다." };
  }
  // 파일 내용, manifest 원문, 환경 설정을 응답에 싣지 않는다.
  const { manifestPath: _, ...lastBackup } = data.lastBackup ?? {};
  return { state: "recorded", ...(data.lastBackup ? { lastBackup: lastBackup as OperationsHistory["lastBackup"] } : {}), ...(data.lastRestoreCheck ? { lastRestoreCheck: data.lastRestoreCheck } : {}) };
}

export function registerLocalOperationsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/local/operations", async (req, reply) => {
    // 다른 조직의 owner/API 키라도 호스트 백업 정보를 조회해서는 안 된다.
    if (!ctx.env.LOCAL_NO_AUTH || req.auth.via !== "local" || req.auth.role !== "owner") {
      throw new ForbiddenError("local owner access required");
    }
    reply.header("cache-control", "no-store");
    return { version: 1, mode: "local-read-only", observedAt: new Date().toISOString(), backupRoot: BACKUP_ROOT, history: await readOperationsHistory() };
  });
}
