import { describe, it, expect } from "vitest";
import { diffText, applyDiff, transformCaret } from "../lib/textarea-binding.js";
import { matchRoute } from "../lib/router.js";
import { messageText, messageToolCalls } from "../lib/api.js";
import * as Y from "yjs";

/**
 * UI의 '틀리면 눈에 잘 안 띄지만 치명적인' 순수 로직만 테스트한다.
 * 렌더링은 브라우저로 직접 확인했고(문서 참조), 여기서는 회귀를 막는다.
 */

describe("diffText — textarea 편집 구간 계산", () => {
  it("끝에 추가", () => {
    expect(diffText("abc", "abcd")).toEqual({ index: 3, removed: 0, inserted: "d" });
  });
  it("앞에 추가", () => {
    expect(diffText("abc", "Xabc")).toEqual({ index: 0, removed: 0, inserted: "X" });
  });
  it("중간 삭제", () => {
    expect(diffText("abcdef", "abef")).toEqual({ index: 2, removed: 2, inserted: "" });
  });
  it("중간 교체", () => {
    expect(diffText("hello world", "hello brave world")).toEqual({
      index: 6, removed: 0, inserted: "brave ",
    });
  });
  it("전체 교체", () => {
    expect(diffText("abc", "xyz")).toEqual({ index: 0, removed: 3, inserted: "xyz" });
  });
  it("변화 없음은 null", () => {
    expect(diffText("same", "same")).toBeNull();
  });
  it("한글(멀티바이트)도 코드유닛 기준으로 정확하다", () => {
    expect(diffText("가나다", "가라나다")).toEqual({ index: 1, removed: 0, inserted: "라" });
  });
  it("반복 문자에서도 최소 구간을 찾는다", () => {
    // "aaa" → "aaaa": 접두/접미가 겹쳐도 removed가 음수가 되면 안 된다
    const d = diffText("aaa", "aaaa")!;
    expect(d.removed).toBe(0);
    expect(d.inserted).toBe("a");
  });
});

describe("applyDiff — Y.Text에 적용", () => {
  it("계산한 구간만 바꾼다 (전체 교체가 아니다)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("body");
    text.insert(0, "hello world");

    // 원격 피어가 문서를 관찰한다고 가정하고, 업데이트가 최소한인지 본다.
    let updates = 0;
    doc.on("update", () => updates++);

    applyDiff(text, diffText("hello world", "hello brave world")!);
    expect(text.toJSON()).toBe("hello brave world");
    // 한 트랜잭션 = 업데이트 1건. 나뉘면 상대가 중간 상태를 본다.
    expect(updates).toBe(1);
  });

  it("동시 편집이 서로를 지우지 않는다", () => {
    // 두 문서를 각각 편집한 뒤 병합했을 때 양쪽 변경이 모두 살아남아야 한다.
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("body").insert(0, "base");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    applyDiff(a.getText("body"), diffText("base", "baseA")!);
    applyDiff(b.getText("body"), diffText("base", "Bbase")!);

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(a.getText("body").toJSON()).toBe(b.getText("body").toJSON());
    expect(a.getText("body").toJSON()).toContain("A");
    expect(a.getText("body").toJSON()).toContain("B");
  });
});

describe("transformCaret — 원격 편집 후 커서 보정", () => {
  it("커서 뒤의 변경은 커서를 움직이지 않는다", () => {
    expect(transformCaret(5, { index: 10, removed: 0, inserted: "xyz" })).toBe(5);
  });
  it("커서 앞 삽입은 그만큼 뒤로 민다", () => {
    expect(transformCaret(5, { index: 0, removed: 0, inserted: "xyz" })).toBe(8);
  });
  it("커서 앞 삭제는 그만큼 앞으로 당긴다", () => {
    expect(transformCaret(10, { index: 2, removed: 3, inserted: "" })).toBe(7);
  });
  it("커서를 걸치는 삭제는 삭제 시작점 이전으로 내려가지 않는다", () => {
    // index=2에서 100자 삭제, 커서는 5 → 삭제된 영역 안이므로 2로 수렴해야 한다
    expect(transformCaret(5, { index: 2, removed: 100, inserted: "" })).toBe(2);
  });
  it("교체(삭제+삽입)를 함께 반영한다", () => {
    expect(transformCaret(10, { index: 0, removed: 4, inserted: "abcdef" })).toBe(12);
  });
});

describe("matchRoute", () => {
  it("파라미터를 뽑는다", () => {
    expect(matchRoute("/collab/:doc", "/collab/my-doc")).toEqual({ doc: "my-doc" });
  });
  it("세그먼트 수가 다르면 실패", () => {
    expect(matchRoute("/collab/:doc", "/collab")).toBeNull();
    expect(matchRoute("/collab/:doc", "/collab/a/b")).toBeNull();
  });
  it("고정 세그먼트가 다르면 실패", () => {
    expect(matchRoute("/collab/:doc", "/chat/x")).toBeNull();
  });
  it("URL 인코딩된 파라미터를 디코딩한다", () => {
    expect(matchRoute("/collab/:doc", "/collab/%EB%AC%B8%EC%84%9C")).toEqual({ doc: "문서" });
  });
});

describe("messageText — jsonb 콘텐츠 정규화", () => {
  it("실제 저장 형태에서 텍스트를 꺼낸다", () => {
    expect(messageText({ text: "안녕", toolCalls: null })).toBe("안녕");
  });
  it("문자열도 그대로 처리한다 (구버전 호환)", () => {
    expect(messageText("plain")).toBe("plain");
  });
  it("null은 빈 문자열", () => {
    expect(messageText(null)).toBe("");
  });
  it("알 수 없는 형태는 JSON으로 보여준다 — 조용히 사라지면 디버깅이 불가능하다", () => {
    expect(messageText({ toolCallId: "abc" })).toBe('{"toolCallId":"abc"}');
  });
  it("도구 호출을 꺼낸다", () => {
    expect(messageToolCalls({ text: "", toolCalls: [{ id: "1", name: "read_file" }] }))
      .toEqual([{ id: "1", name: "read_file" }]);
    expect(messageToolCalls("plain")).toEqual([]);
    expect(messageToolCalls(null)).toEqual([]);
  });
});
