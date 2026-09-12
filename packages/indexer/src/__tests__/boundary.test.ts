import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", () => mocks);
import { Indexer } from "../indexer.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue("");
  mocks.readdir.mockResolvedValue([{ name: "note.md", isDirectory: () => false, isFile: () => true }]);
  mocks.stat.mockResolvedValue({ size: 16 });
});
function fixture() {
  const query = vi.fn(async (_sql: string) => ({ rows: [] }));
  const embed = vi.fn();
  return { indexer: new Indexer({ query } as unknown as Pool, embed), query, embed };
}
describe("색인 파일 읽기 전 권한 검증", () => {
  it(".gitignore 검증 실패를 없는 파일로 삼키거나 내용을 먼저 읽지 않는다", async () => {
    const f = fixture();
    await expect(f.indexer.indexProject("project", "/fixture", undefined, async () => { throw new Error("denied fixture link"); })).rejects.toThrow("denied fixture link");
    expect(mocks.readFile).not.toHaveBeenCalled(); expect(mocks.readdir).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  it("하드링크 등 본문 검증 실패는 파일 읽기·임베딩·DB 변경보다 먼저 전파된다", async () => {
    const f = fixture();
    const validate = vi.fn(async (file: string) => { if (file.endsWith("note.md")) throw new Error("denied fixture hardlink"); });
    await expect(f.indexer.indexProject("project", "/fixture", undefined, validate)).rejects.toThrow("denied fixture hardlink");
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual(["/fixture/.gitignore"]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.query.mock.calls.every(([sql]) => /^select /.test(sql))).toBe(true);
  });
  it("callback은 선택적이어서 기존 독립 인덱서의 빈 폴더 동작을 유지한다", async () => {
    const f = fixture(); mocks.readdir.mockResolvedValue([]);
    await expect(f.indexer.indexProject("project", "/fixture")).resolves.toEqual({ added: 0, updated: 0, removed: 0 });
  });
});
