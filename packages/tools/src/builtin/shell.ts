import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolOutput } from "../registry.js";

/**
 * run_command — Docker 샌드박스에서 명령 실행.
 *
 * LLM이 생성한 명령은 정의상 신뢰 불가 입력이다(프롬프트 인젝션 경유 가능).
 * 방어층:
 *  --network=none      : 데이터 유출/원격 페이로드 다운로드 차단
 *  --memory/--cpus     : 리소스 폭주(포크밤, 무한루프) 봉쇄
 *  --pids-limit        : 포크밤 이중 방어
 *  --read-only + tmpfs : 컨테이너 파일시스템 불변, 쓰기는 /workspace와 /tmp만
 *  비루트(uid 10001)   : sandbox.Dockerfile에서 강제
 *  execFile            : 호스트 셸 미경유 — 호스트 측 인젝션 표면 제거
 */

export interface SandboxOptions {
  image: string;
  timeoutMs?: number;
  /** 빌드 도구가 네트워크를 요구하는 경우에만 명시적으로 허용 */
  allowNetwork?: boolean;
  memory?: string;
  cpus?: string;
  workspaceReadOnly?: boolean;
}

/** 모델이 프롬프트의 호스트 절대경로를 cwd로 써도 같은 프로젝트 디렉터리를 가리키게 한다. */
export function sandboxWorkdir(projectRoot: string, cwd: string): string {
  const target = cwd === "/workspace" || cwd.startsWith("/workspace/")
    ? resolve(projectRoot, `.${cwd.slice("/workspace".length)}`)
    : resolve(projectRoot, cwd);
  const subpath = relative(resolve(projectRoot), target);
  if (subpath === ".." || subpath.startsWith("../") || isAbsolute(subpath)) throw new Error("cwd must stay inside the project workspace");
  return subpath ? `/workspace/${subpath}` : "/workspace";
}

export function createRunCommandTool(opts: SandboxOptions): ToolDefinition {
  return {
    name: "run_command",
    description:
      "Run a shell command inside an isolated Docker sandbox mounted at the project root. " +
      "No network access. " + (opts.workspaceReadOnly ? "Workspace is read-only; write files with write_file after approval. Use /tmp for test artifacts." : "Use for builds, tests, and scripts."),
    permission: "exec",
    requiresSandbox: true,
    schema: z.object({
      command: z.string().min(1).max(4000),
      cwd: z.string().default("."),
    }),
    handler(ctx, args) {
      const containerName = `aios-tool-${randomUUID()}`;
      const dockerArgs = [
        "run",
        "--rm",
        "--name", containerName,
        "--init",
        opts.allowNetwork ? "--network=bridge" : "--network=none",
        `--memory=${opts.memory ?? "512m"}`,
        `--cpus=${opts.cpus ?? "1"}`,
        "--pids-limit=256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=128m",
        "--security-opt",
        "no-new-privileges",
        "-v",
        `${ctx.projectRoot}:/workspace:${opts.workspaceReadOnly ? "ro" : "rw"}`,
        "-w",
        sandboxWorkdir(ctx.projectRoot, String(args.cwd)),
        opts.image,
        "bash",
        "-lc",
        args.command, // 인자로 전달 — 호스트 셸을 거치지 않음
      ];

      return new Promise<ToolOutput>((resolvePromise, reject) => {
        const child = execFile(
          "docker",
          dockerArgs,
          { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal },
          (err, stdout, stderr) => {
            const combined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
            if (ctx.signal.aborted || (err && (err as { killed?: boolean }).killed)) {
              // Docker CLI 종료만으로 컨테이너 실행은 중단되지 않는다. 이번 호출의 컨테이너만 정리한다.
              execFile("docker", ["rm", "-f", containerName], { timeout: 10_000 }, () => {
                reject(new Error(`${ctx.signal.aborted ? "command cancelled" : "command timed out"}\n${combined}`));
              });
            } else if (err && typeof (err as { code?: number }).code === "number") {
              const exitCode = (err as unknown as { code: number }).code;
              resolvePromise({ output: `exit code ${exitCode}\n${combined}`, exitCode });
            } else if (err) {
              // 항상 Error 인스턴스로 reject 한다: 상위 executor가 err.message를 읽고,
              // 문자열/객체로 reject 하면 "[object Object]" 같은 무의미한 로그가 남는다.
              reject(err instanceof Error ? err : new Error(JSON.stringify(err) ?? "unknown exec failure"));
            } else {
              resolvePromise({ output: combined || "(no output)", exitCode: 0 });
            }
          },
        );
        child.on("error", reject);
      });
    },
  };
}
