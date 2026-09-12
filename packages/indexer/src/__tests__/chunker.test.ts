import { describe, expect, it } from "vitest";
import { chunkCode, detectLang, isIndexable } from "../chunker.js";

describe("chunkCode", () => {
  it("splits at top-level declarations and extracts symbols", () => {
    const src = [
      "import x from 'y';",
      "",
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export class Beta {",
      "  method() {}",
      "}",
    ].join("\n");
    const chunks = chunkCode(src);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("alpha");
    expect(symbols).toContain("Beta");
  });

  it("windows long declaration-less files with overlap", () => {
    const src = Array.from({ length: 400 }, (_, i) => `  line ${i}`).join("\n");
    const chunks = chunkCode(src);
    expect(chunks.length).toBeGreaterThan(2);
    // 오버랩: 다음 청크 시작이 이전 청크 끝보다 앞선다
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine);
    // 경계 유실 없음: 마지막 라인이 어느 청크엔가 포함된다
    expect(chunks.at(-1)!.endLine).toBe(400);
  });

  it("detects languages and rejects oversized/binary-ish files", () => {
    expect(detectLang("src/a.ts")).toBe("typescript");
    expect(detectLang("x.unknown")).toBeNull();
    expect(isIndexable("big.ts", 2_000_000)).toBe(false);
    expect(isIndexable("ok.py", 1000)).toBe(true);
  });
});
