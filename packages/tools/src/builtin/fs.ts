import { readFile, mkdir, readdir, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, relative, isAbsolute, sep, join } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * 파일 도구 — path jail이 핵심.
 * 프롬프트 인젝션으로 "../../../etc/passwd" 나 "~/.ssh/id_rsa" 를 읽으려는 시도는
 * 반드시 발생한다고 가정하고, 프로젝트 루트 밖 접근을 경로 정규화 단계에서 차단한다.
 */

/**
 * 도구가 건드리면 안 되는 디렉터리.
 *
 * `.git` 은 프로젝트 루트 **안에** 있으므로 탈출 검사만으로는 걸리지 않는다.
 * 그런데 여기는 에이전트의 영역이 아니다:
 *
 *  - 이 제품은 "모든 파일 변경을 git 커밋으로 체크포인트한다"를 안전망으로 삼는다.
 *    에이전트가 `.git` 을 망가뜨리면 **그 안전망 자체가 사라진다** — 사용자가 무엇이
 *    바뀌었는지 보거나 되돌릴 방법을 잃는다.
 *  - `.git/config` 에는 원격 저장소 자격 증명이 들어 있을 수 있다. 읽기도 막는 이유다.
 *  - git 작업은 전용 도구(packages/tools/src/builtin/git.ts)를 통해야 한다.
 *    그쪽은 무엇을 허용할지 명시적으로 정한다.
 *
 * `list_dir` 는 이미 `.git` 을 목록에서 빼고 있었다 — 의도는 처음부터 있었고
 * 읽기·쓰기 경로에만 강제가 빠져 있었다.
 */
const FORBIDDEN_DIRS = new Set([".git"]);

export function jailPath(projectRoot: string, userPath: string): string {
  const abs = resolve(projectRoot, userPath);
  const rel = relative(resolve(projectRoot), abs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`path escapes project root: ${userPath}`);
  }
  // 경로의 어느 위치에 있든 막는다 — 중첩 저장소(예: vendor/lib/.git)도 같은 이유로 위험하다.
  if (rel.split(sep).some((seg) => FORBIDDEN_DIRS.has(seg.toLowerCase()))) {
    throw new Error(`path is off limits: ${userPath} (use the git tool for repository operations)`);
  }
  return abs;
}

/** 심볼릭 링크·하드 링크를 통한 경로 우회를 거부한다. 외부 호스트 프로세스의 동시 교체는 별도 신뢰 경계다. */
export async function safeJailPath(projectRoot: string, userPath: string): Promise<string> {
  const root = resolve(projectRoot);
  const abs = jailPath(root, userPath);
  if ((await realpath(root)).normalize("NFC") !== root.normalize("NFC")) throw new Error("workspace root must not contain symbolic links");
  let current = root;
  for (const segment of relative(root, abs).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const stat = await lstat(current).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) break;
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error("linked paths are not allowed");
  }
  return abs;
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the project. Returns content with line numbers.",
  permission: "read",
  schema: z.object({
    path: z.string().describe("Path relative to project root"),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  async handler(ctx, args) {
    const abs = await safeJailPath(ctx.projectRoot, args.path);
    const content = await readFile(abs, "utf8");
    const lines = content.split("\n");
    const start = (args.startLine ?? 1) - 1;
    const end = args.endLine ?? lines.length;
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}\t${l}`)
      .join("\n");
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Create or overwrite a file in the project.",
  permission: "write",
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  async handler(ctx, args) {
    const abs = await safeJailPath(ctx.projectRoot, args.path);
    await mkdir(dirname(abs), { recursive: true });
    await safeJailPath(ctx.projectRoot, args.path);
    const existing = await lstat(abs).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    const temp = join(dirname(abs), `.aios-write-${randomUUID()}`);
    const file = await open(temp, "wx", existing ? existing.mode & 0o777 : 0o644);
    try {
      await file.writeFile(args.content, "utf8"); await file.sync(); await file.close();
      ctx.signal.throwIfAborted();
      await safeJailPath(ctx.projectRoot, args.path);
      // 중간 쓰기 실패가 기존 파일을 잘라버리지 않도록 완성된 임시 파일로 교체한다.
      await rename(temp, abs);
    } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
    return `wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
  },
};

export const listDirTool: ToolDefinition = {
  name: "list_dir",
  description: "List entries of a directory in the project.",
  permission: "read",
  schema: z.object({ path: z.string().default(".") }),
  async handler(ctx, args) {
    const abs = await safeJailPath(ctx.projectRoot, args.path);
    const entries = await readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== "node_modules" && e.name.toLowerCase() !== ".git" && !e.name.startsWith("._"))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};
