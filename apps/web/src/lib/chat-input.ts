/** 조합 확정용 Enter는 전송이 아니다. Safari의 IME keyCode 229도 포함한다. */
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }, composing: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing;
}
