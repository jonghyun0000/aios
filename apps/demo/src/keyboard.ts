/** Safari/Windows 한글 IME는 조합 마지막 Enter를 keyCode 229로 알리는 경우도 있다. */
export function shouldSend(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; repeat: boolean; isComposing: boolean; keyCode: number }, composing: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.isComposing && event.keyCode !== 229 && !composing;
}
