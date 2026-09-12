import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertState, loadCheckpoint, prepareCheckpoint, restoreCheckpoint, saveCheckpoint } from "../execution/checkpoints.js";

async function fixture() {
  const base = "/Volumes/T7/bigdata/test-workspaces/stage3-unit";
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  const store = join(base, "checkpoints");
  return { root, store };
}
describe("실제 파일 체크포인트·결함 주입", () => {
  it("변경 전후 해시를 확인하고 새 서비스가 읽을 수 있는 백업으로 원본을 복구한다", async () => {
    const { root, store } = await fixture(); const path = join(root, "note.txt");
    await writeFile(path, "before\n");
    const cp = await prepareCheckpoint(root, "note.txt", "after\n");
    const id = randomUUID(); await saveCheckpoint(store, id, cp);
    await writeFile(path, cp.after); await assertState(root, cp, cp.afterHash);
    await restoreCheckpoint(root, await loadCheckpoint(store, id));
    expect(await readFile(path, "utf8")).toBe("before\n");
  });
  it("수동 수정 결함을 승인 전 검사와 복구 검사 모두에서 차단한다", async () => {
    const { root } = await fixture(); const path = join(root, "note.txt");
    await writeFile(path, "before"); const cp = await prepareCheckpoint(root, "note.txt", "after");
    await writeFile(path, "manual edit");
    await expect(assertState(root, cp, cp.beforeHash)).rejects.toThrow(/변경/);
    await expect(restoreCheckpoint(root, cp)).rejects.toThrow(/변경/);
    expect(await readFile(path, "utf8")).toBe("manual edit");
  });
  it("이번 실행의 새 파일만 제거하고 백업은 남긴다", async () => {
    const { root, store } = await fixture(); const path = join(root, "new.txt");
    const cp = await prepareCheckpoint(root, "new.txt", "created"); const id = randomUUID();
    await saveCheckpoint(store, id, cp); await writeFile(path, "created");
    await restoreCheckpoint(root, cp); await expect(readFile(path)).rejects.toThrow(/ENOENT/);
    expect((await loadCheckpoint(store, id)).after).toBe("created");
  });
  it("백업 변조를 실제로 주입하면 무결성 검사가 실패한다", async () => {
    const { root, store } = await fixture(); const cp = await prepareCheckpoint(root, "new.txt", "created"); const id = randomUUID();
    await saveCheckpoint(store, id, cp); await writeFile(join(store, `${id}.json`), JSON.stringify({ ...cp, after: "corrupted" }));
    await expect(loadCheckpoint(store, id)).rejects.toThrow(/무결성/);
  });
  it("작업 폴더 탈출·Git 경로·바이너리·대용량 파일을 거부한다", async () => {
    const { root } = await fixture();
    await expect(prepareCheckpoint(root, "../escape", "x")).rejects.toThrow(/escapes/);
    await expect(prepareCheckpoint(root, ".GIT/config", "x")).rejects.toThrow(/off limits/);
    await writeFile(join(root, "binary"), Buffer.from([0, 255]));
    await expect(prepareCheckpoint(root, "binary", "x")).rejects.toThrow(/UTF-8/);
    await expect(prepareCheckpoint(root, "large", "a".repeat(65537))).rejects.toThrow(/64 KiB/);
  });
});
