import { describe, expect, it } from "vitest";
import { parseSse } from "../sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("parseSse", () => {
  it("parses events split across arbitrary chunk boundaries", async () => {
    // 실제 네트워크에서 프레임은 임의 지점에서 쪼개진다 — 파서의 핵심 요구사항
    const stream = streamOf(['event: message\nda', 'ta: {"a":1}\n\ndata: [DO', "NE]\n\n"]);
    const out = [];
    for await (const msg of parseSse(stream)) out.push(msg);
    expect(out).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: undefined, data: "[DONE]" },
    ]);
  });

  it("joins multi-line data fields and normalizes CRLF", async () => {
    const stream = streamOf(["data: line1\r\ndata: line2\r\n\r\n"]);
    const out = [];
    for await (const msg of parseSse(stream)) out.push(msg);
    expect(out[0]!.data).toBe("line1\nline2");
  });
});
