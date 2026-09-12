import type * as Y from "yjs";

/**
 * <textarea> ↔ Y.Text 바인딩.
 *
 * 순진한 구현("입력 이벤트마다 Y.Text를 통째로 교체")이 왜 틀렸는가:
 *  - 전체 교체는 delete(전체) + insert(전체)가 되어, 동시에 편집 중인 상대의 변경을
 *    전부 덮어쓴다. CRDT를 쓰는 의미가 사라진다.
 *  - 커서가 매 입력마다 끝으로 튄다.
 *
 * 그래서 실제 변경 구간만 계산해 적용한다:
 *  공통 접두사와 공통 접미사를 잘라내면 남는 것이 "바뀐 구간"이다.
 *  IME 조합, 붙여넣기, 여러 글자 삭제 모두 이 한 가지 계산으로 처리된다.
 */
export interface TextDiff {
  index: number;
  removed: number;
  inserted: string;
}

export function diffText(before: string, after: string): TextDiff | null {
  if (before === after) return null;

  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  return {
    index: start,
    removed: endBefore - start,
    inserted: after.slice(start, endAfter),
  };
}

export function applyDiff(ytext: Y.Text, diff: TextDiff): void {
  // 한 트랜잭션 안에서 처리해야 원격에 delete와 insert가 하나의 업데이트로 전달된다.
  // 나누면 중간 상태(지워지기만 한 문서)가 상대 화면에 잠깐 보인다.
  ytext.doc?.transact(() => {
    if (diff.removed > 0) ytext.delete(diff.index, diff.removed);
    if (diff.inserted) ytext.insert(diff.index, diff.inserted);
  });
}

/**
 * 원격 변경 후 로컬 커서 위치를 보정한다.
 *
 * 이게 없으면: 상대가 내 커서 **앞쪽**에 글자를 넣을 때마다 내 커서가 그만큼 뒤로 밀린 위치에
 * 남아 있어야 하는데, textarea 값을 교체하면 위치가 그대로 유지되어 커서가 엉뚱한 곳을 가리킨다.
 * 문서 앞부분을 편집하는 동료가 있으면 타이핑이 불가능해진다.
 */
export function transformCaret(caret: number, diff: TextDiff): number {
  if (diff.index >= caret) return caret;               // 변경이 커서 뒤 → 영향 없음
  const removedBefore = Math.min(diff.removed, caret - diff.index);
  return caret - removedBefore + diff.inserted.length;
}
