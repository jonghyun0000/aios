import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TempWorkspaceRegistry } from "../temp-workspaces.js";

const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await rm(fixture, { recursive: true, force: true });
  }
});

describe("TempWorkspaceRegistry", () => {
  it("심볼릭 별칭 부모에서도 jail에 전달할 실제 경로를 만들고 자신이 만든 폴더만 정리한다", async () => {
    const fixture = await mkdtemp(join(await realpath(tmpdir()), "aios-temp-registry-test-"));
    fixtures.push(fixture);
    const actualParent = join(fixture, "actual");
    const aliasParent = join(fixture, "alias");
    await mkdir(actualParent);
    await symlink(actualParent, aliasParent, "dir");

    const registry = new TempWorkspaceRegistry();
    const workspace = await registry.create("workspace-", aliasParent);

    expect(workspace).toBe(await realpath(workspace));
    expect(dirname(workspace)).toBe(await realpath(actualParent));
    expect((await lstat(workspace)).isDirectory()).toBe(true);

    await registry.cleanup();
    await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(actualParent)).isDirectory()).toBe(true);
  });
});
