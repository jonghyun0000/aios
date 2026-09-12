import { describe, it, expect } from "vitest";
import { shouldSendOnEnter } from "../lib/chat-input.js";

const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
describe("채팅 Enter 전송", () => {
  it("Enter는 전송, Shift+Enter는 줄바꿈", () => {
    expect(shouldSendOnEnter(enter, false)).toBe(true);
    expect(shouldSendOnEnter({ ...enter, shiftKey: true }, false)).toBe(false);
    expect(shouldSendOnEnter({ ...enter, key: "a" }, false)).toBe(false);
  });
  it("조합 중 Enter와 Safari 229는 전송하지 않는다", () => {
    expect(shouldSendOnEnter({ ...enter, isComposing: true }, false)).toBe(false);
    expect(shouldSendOnEnter({ ...enter, keyCode: 229 }, false)).toBe(false);
    expect(shouldSendOnEnter(enter, true)).toBe(false);
  });
  it("결함 주입: IME 보호를 제거하면 조합 확정 전송을 검출한다", () => {
    const broken = (event: typeof enter) => event.key === "Enter" && !event.shiftKey;
    expect(() => expect(broken({ ...enter, isComposing: true })).toBe(false)).toThrow();
  });
});
