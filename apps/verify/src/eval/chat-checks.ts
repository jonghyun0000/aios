/** 시간 측정용 인사 응답의 기본 유효성. 특정 인사 단어 하나를 강제하지 않는다. */
export function isKoreanGreeting(text: string): boolean {
  const value = text.trim();
  return value.length >= 5 && value.length < 200 && /[가-힣]/.test(value)
    && /안녕|반갑|뵙|만나|만난/.test(value) && !/[一-鿿぀-ヿ]/.test(value)
    && value.split(/[.!?]+/).filter((s) => s.trim()).length === 1;
}
