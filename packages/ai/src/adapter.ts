import { ProviderError } from "@aios/shared";
import type { CompletionRequest, ProviderId, StreamEvent } from "@aios/shared";

/**
 * 프로바이더 어댑터 계약.
 *
 * 공식 SDK 대신 raw HTTP + 자체 SSE 파서를 쓰는 이유(핵심 설계 결정):
 *  1) 4개 SDK의 스트리밍 추상화·재시도 정책이 제각각이라 그 위에 또 어댑터를 얹으면
 *     이중 추상화가 된다. REST 표면은 얇고 안정적이다.
 *  2) 폴백/서킷브레이커는 라우터의 책임인데 SDK 내부 재시도가 이를 오염시킨다.
 *  3) 의존성 표면 축소 = 공급망·번들 크기·버전 지옥 축소.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  stream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, void>;
  /** 임베딩 미지원 프로바이더는 구현하지 않음 */
  embed?(texts: string[], model?: string): Promise<number[][]>;
}

/** fetch 응답이 실패면 본문을 읽어 의미있는 에러 메시지를 만든다 */
export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * 네트워크 레벨 실패를 폴백 가능한 ProviderError로 감싼다.
 *
 * 왜 필요한가: fetch가 HTTP 응답을 받지 못하고 던지는 경우(DNS 실패, 경로 없음, TLS,
 * 커넥션 리셋)는 status가 없어 raw TypeError/AggregateError로 올라온다. 그러면
 * 라우터의 isRetryable()이 false를 반환해 **다른 프로바이더로 넘어가지 않는다** —
 * 정작 폴백이 가장 필요한 상황에서 폴백이 죽는다.
 * (IPv6 경로가 없는 네트워크에서 EHOSTUNREACH로 전체 실행이 중단되는 것을 실측했다.)
 *
 * abort는 예외다: 사용자가 취소한 것이므로 다른 프로바이더로 재시도하면 안 된다.
 */
export function wrapNetworkError(provider: ProviderId, err: unknown): never {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
  if (err instanceof ProviderError) throw err;

  const codes = collectErrorCodes(err);
  const detail = codes.length ? ` (${[...new Set(codes)].join(", ")})` : "";
  const message = err instanceof Error ? err.message : String(err);
  // upstreamStatus 0 = 응답을 받기 전 연결 단계 실패. retryable=true 이며,
  // 라우터는 이 경우에만 "같은 모델로 백오프 재시도"를 적용한다.
  throw new ProviderError(provider, `network failure: ${message}${detail}`, { status: 0, cause: err });
}

/** AggregateError(Happy Eyeballs의 다중 시도)까지 훑어 errno 코드를 모은다 */
function collectErrorCodes(err: unknown, depth = 0): string[] {
  if (depth > 3 || !err) return [];
  const out: string[] = [];
  const e = err as { code?: string; errors?: unknown[]; cause?: unknown };
  if (typeof e.code === "string") out.push(e.code);
  if (Array.isArray(e.errors)) for (const sub of e.errors) out.push(...collectErrorCodes(sub, depth + 1));
  if (e.cause) out.push(...collectErrorCodes(e.cause, depth + 1));
  return out;
}
