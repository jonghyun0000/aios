/**
 * 토큰 수 근사 추정기.
 *
 * 정확한 토크나이저(tiktoken 등)를 쓰지 않는 이유:
 *  - 프로바이더 4사 토크나이저가 전부 다르다. "정확한" 값 자체가 존재하지 않는다.
 *  - 용도는 프롬프트 예산 할당이며, 실제 소비량은 프로바이더가 usage로 돌려준다(과금은 실측 기반).
 *
 * 추정 방향은 반드시 '보수적(과대)'이어야 한다:
 *   과소 추정 → 예산을 넘겨 전송 → 컨텍스트 초과로 요청 전체 실패
 *   과대 추정 → 컨텍스트를 조금 덜 채움 (품질 손실은 미미)
 * 비대칭 비용이 명확하므로 계수를 과대 쪽으로 잡는다.
 *
 * 계수 근거(실측): Anthropic API 실호출로 영문 산문 45,000자를 보냈을 때 실제 72,033 토큰이
 * 소비됐다 — 약 2.7 chars/token. chars/4 휴리스틱은 37% 과소 계산이었다(Phase 1에서 발견).
 * 코드/마크다운은 구두점이 많아 밀도가 더 높으므로 2.7을 기본값으로 채택한다.
 * CJK는 문자당 1토큰을 넘는 경우가 흔해 1.0으로 잡는다.
 */
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/g;

const LATIN_CHARS_PER_TOKEN = 2.7;
const CJK_CHARS_PER_TOKEN = 1.0;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(otherCount / LATIN_CHARS_PER_TOKEN + cjkCount / CJK_CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(
  messages: { content: string }[],
  perMessageOverhead = 4,
): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + perMessageOverhead, 0);
}
