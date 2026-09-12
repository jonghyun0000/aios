import { describe, it, expect } from "vitest";
import { parseExtractedFacts } from "../engine.js";

/**
 * 모델 출력 → 기억 항목 변환 회귀 테스트.
 *
 * 실제로 겪은 장애: 로컬 모델이 허용 집합 밖의 kind 를 냈고, 그 값이 검증 없이 INSERT 되어
 *   new row for relation "memory_items" violates check constraint "memory_items_kind_check"
 * 로 터졌다. 그 예외가 전체 시나리오를 죽였다 — 호출부는 "추출 실패는 치명적이지 않다"고
 * 주석까지 달아 두었지만 JSON 파싱 실패만 막고 있었다.
 *
 * 모델 출력은 데이터다. 스키마에 닿기 전에 좁힌다.
 */
describe("parseExtractedFacts", () => {
  it("정상 출력을 그대로 통과시킨다", () => {
    const out = parseExtractedFacts(
      '[{"kind":"preference","content":"사용자는 TypeScript를 선호한다","importance":0.8}]');
    expect(out).toEqual([{ kind: "preference", content: "사용자는 TypeScript를 선호한다", importance: 0.8 }]);
  });

  it("허용 집합 밖의 kind 는 fact 로 둔다 — 분류가 틀렸다고 사실이 사라질 이유는 없다", () => {
    // 이것이 DB 제약을 위반해 세션을 죽였던 입력이다.
    const out = parseExtractedFacts('[{"kind":"observation","content":"배포는 화요일","importance":0.5}]');
    expect(out).toEqual([{ kind: "fact", content: "배포는 화요일", importance: 0.5 }]);
  });

  it("kind 의 대소문자와 공백을 흡수한다", () => {
    const out = parseExtractedFacts('[{"kind":"  Decision ","content":"pgvector를 쓴다","importance":0.9}]');
    expect(out[0]!.kind).toBe("decision");
  });

  it("content 가 없거나 비어 있으면 버린다 — 내용 없는 기억은 잡음이다", () => {
    const out = parseExtractedFacts(
      '[{"kind":"fact","content":"   ","importance":0.5},{"kind":"fact","importance":0.5},' +
      '{"kind":"fact","content":123,"importance":0.5},{"kind":"fact","content":"살아남는다","importance":0.5}]');
    expect(out).toEqual([{ kind: "fact", content: "살아남는다", importance: 0.5 }]);
  });

  it("importance 를 0..1 로 조이고, 숫자가 아니면 0.5 로 둔다", () => {
    const out = parseExtractedFacts(
      '[{"kind":"fact","content":"a","importance":9},{"kind":"fact","content":"b","importance":-3},' +
      '{"kind":"fact","content":"c","importance":"높음"},{"kind":"fact","content":"d"}]');
    expect(out.map((f) => f.importance)).toEqual([1, 0, 0.5, 0.5]);
  });

  it("코드펜스로 감싼 출력을 처리한다 — 모델이 흔히 그렇게 낸다", () => {
    const out = parseExtractedFacts('```json\n[{"kind":"fact","content":"감싸져 있었다","importance":0.5}]\n```');
    expect(out).toHaveLength(1);
  });

  it("파싱할 수 없거나 배열이 아니면 빈 목록 — 던지지 않는다", () => {
    // 추출 실패로 세션이 죽으면 안 된다. 그것이 원래 의도였다.
    for (const bad of ["", "죄송합니다, 추출할 내용이 없습니다.", '{"kind":"fact"}', "null", "[[]]"]) {
      expect(() => parseExtractedFacts(bad)).not.toThrow();
    }
    expect(parseExtractedFacts("죄송합니다")).toEqual([]);
    expect(parseExtractedFacts('{"kind":"fact","content":"객체다"}')).toEqual([]);
  });

  it("아주 긴 content 는 잘라 낸다 — 임베딩 비용과 저장 낭비를 막는다", () => {
    const out = parseExtractedFacts(JSON.stringify([{ kind: "fact", content: "가".repeat(5000), importance: 0.5 }]));
    expect(out[0]!.content.length).toBe(2000);
  });
});
