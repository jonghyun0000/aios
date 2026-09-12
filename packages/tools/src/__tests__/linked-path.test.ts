import { describe, expect, it, vi } from "vitest";
import { lstat, realpath } from "node:fs/promises";
import { safeJailPath } from "../builtin/fs.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), lstat: vi.fn(), realpath: vi.fn() }));
describe("링크 경로 결함 주입", () => {
  it("같은 경로가 일반 파일이면 허용하고 심볼릭·하드 링크로 바뀌면 거부한다", async () => {
    vi.mocked(realpath).mockResolvedValue("/test-root");
    for (const [symlink, nlink, allowed] of [[false, 1, true], [true, 1, false], [false, 2, false]] as const) {
      vi.mocked(lstat).mockResolvedValue({ isSymbolicLink: () => symlink, isFile: () => true, nlink } as Awaited<ReturnType<typeof lstat>>);
      if (allowed) await expect(safeJailPath("/test-root", "file.txt")).resolves.toBe("/test-root/file.txt");
      else await expect(safeJailPath("/test-root", "file.txt")).rejects.toThrow(/linked/);
    }
    vi.mocked(realpath).mockResolvedValue("/outside");
    await expect(safeJailPath("/test-root", "file.txt")).rejects.toThrow(/symbolic/);
  });
});
