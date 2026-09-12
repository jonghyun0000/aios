import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Git 자동 커밋 서비스.
 *
 * isomorphic-git 대신 시스템 git을 execFile로 호출하는 이유:
 *  - hooks/gitattributes/sparse-checkout 등 엣지 케이스에서 순수 JS 구현은 미묘하게 어긋난다.
 *  - 개발자 머신에는 git이 반드시 있고, execFile(셸 미경유)이라 인젝션 표면도 없다.
 *
 * 자동 커밋의 목적: 에이전트의 파일 편집을 '되돌릴 수 있는 단위'로 만드는 것.
 * 커밋 = undo 단위. 신뢰는 되돌리기 가능성에서 나온다.
 */
export class GitService {
  constructor(private cwd: string) {}

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.git("rev-parse", "--is-inside-work-tree");
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<string> {
    return this.git("status", "--porcelain");
  }

  async diffStat(): Promise<string> {
    return this.git("diff", "--stat");
  }

  /**
   * 체크포인트 자동 커밋. 변경이 없으면 null.
   * --no-verify를 쓰지 않는다: 사용자의 pre-commit 훅(린트/시크릿 스캔)은 에이전트에게도
   * 동일하게 적용되어야 한다. 훅 실패는 에이전트가 고쳐야 할 신호다.
   */
  async autoCommit(summary: string): Promise<{ sha: string; message: string } | null> {
    if (!(await this.isRepo())) return null;
    const dirty = await this.status();
    if (!dirty) return null;

    await this.git("add", "-A");
    const message = `aios: ${sanitizeSubject(summary)}\n\n[aios-checkpoint]`;
    await exec("git", ["commit", "-m", message], {
      cwd: this.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "AIOS Agent",
        GIT_AUTHOR_EMAIL: "agent@aios.dev",
        GIT_COMMITTER_NAME: "AIOS Agent",
        GIT_COMMITTER_EMAIL: "agent@aios.dev",
      },
    });
    const sha = await this.git("rev-parse", "--short", "HEAD");
    return { sha, message };
  }

  /** 체크포인트로 롤백 (사용자 명시 요청 시에만 호출 — 파괴적 조작은 자동화 금지) */
  async revertTo(sha: string): Promise<void> {
    await this.git("revert", "--no-edit", `${sha}..HEAD`);
  }
}

function sanitizeSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 72) || "checkpoint";
}
