/**
 * 에러 계층. 모든 도메인 에러는 AiosError를 상속하며 다음을 강제한다:
 *  - code: 기계가 분기 가능한 안정된 식별자 (API 응답에 그대로 노출)
 *  - status: HTTP 매핑
 *  - retryable: 라우터/클라이언트의 재시도 판단 근거
 * throw new Error(string) 을 금지하는 이유: 재시도 가능 여부가 타입에 없으면
 * 상위 레이어가 문자열 매칭으로 판단하게 되고, 그것은 반드시 부패한다.
 */
export class AiosError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    opts: { status?: number; retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

export class ValidationError extends AiosError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, { status: 400, details });
  }
}

export class AuthError extends AiosError {
  constructor(message = "unauthorized") {
    super("unauthorized", message, { status: 401 });
  }
}

export class ForbiddenError extends AiosError {
  constructor(message = "forbidden") {
    super("forbidden", message, { status: 403 });
  }
}

export class NotFoundError extends AiosError {
  constructor(resource: string) {
    super("not_found", `${resource} not found`, { status: 404 });
  }
}

export class QuotaExceededError extends AiosError {
  constructor(message = "monthly token quota exceeded") {
    super("quota_exceeded", message, { status: 429, retryable: false });
  }
}

/**
 * LLM 프로바이더 호출 실패. 상류 status에 따라 retryable을 자동 판정한다.
 *
 * status(=502)와 upstreamStatus를 분리해 두는 이유:
 *  - status는 '우리 API가 클라이언트에게 돌려줄 코드'다. 프로바이더의 401을 그대로
 *    내보내면 클라이언트가 자기 인증이 틀린 줄 안다 — 항상 502(bad gateway)가 맞다.
 *  - upstreamStatus는 '무슨 일이 있었는가'다. 라우터가 재시도 전략을 고를 때 쓴다
 *    (연결 실패는 같은 모델 재시도, 429/5xx는 다른 프로바이더로 폴백).
 *    문자열 매칭으로 이걸 판별하면 메시지 문구가 바뀌는 순간 조용히 깨진다.
 */
export class ProviderError extends AiosError {
  readonly provider: string;
  /** 프로바이더가 돌려준 HTTP status. 응답 자체를 못 받았으면 0. */
  readonly upstreamStatus: number;
  /** 계정 수준 문제(크레딧 소진·구독 만료·조직 한도)인가 */
  readonly isAccountIssue: boolean;

  constructor(provider: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    const status = opts.status ?? 502;
    // 크레딧 소진·결제 문제는 400/403으로 오지만 '요청'의 문제가 아니라 '계정'의 문제다.
    // 같은 요청을 다른 프로바이더로 보내면 성공한다 — 따라서 폴백 대상이어야 한다.
    // (실측: 검증 중 크레딧이 소진되자 400이 non-retryable로 분류되어 폴백이 죽었다.)
    const accountIssue = ACCOUNT_ISSUE_PATTERN.test(message);
    // 429(rate limit) / 5xx(장애) / 0(연결 실패) / 계정 문제 는 재시도·폴백 가능.
    // 나머지 4xx는 요청 자체가 잘못된 것이므로 다른 프로바이더로 보내도 똑같이 실패한다.
    const retryable = status === 0 || status === 429 || status >= 500 || accountIssue;
    super("provider_error", `[${provider}] ${message}`, { status: 502, retryable, cause: opts.cause });
    this.provider = provider;
    this.upstreamStatus = status;
    this.isAccountIssue = accountIssue;
  }

  /** 응답을 받기 전 연결 단계에서 실패했는가 (DNS·라우팅·TLS·리셋) */
  get isConnectionFailure(): boolean {
    return this.upstreamStatus === 0;
  }
}

/**
 * 계정 수준 실패의 신호.
 * 프로바이더마다 문구가 다르고 전용 에러 코드를 주지 않는 경우가 많아 메시지로 판별한다.
 * 오탐이 나도 손해는 "다른 프로바이더를 한 번 더 시도"뿐이고, 미탐은 "폴백 불능"이므로
 * 넓게 잡는 편이 안전하다.
 */
const ACCOUNT_ISSUE_PATTERN =
  /credit balance|insufficient[_ ]quota|billing|payment required|quota exceeded|exceeded your current quota|spending limit|account.*(suspend|deactivat)/i;

export class ToolExecutionError extends AiosError {
  constructor(tool: string, message: string, opts: { cause?: unknown } = {}) {
    super("tool_error", `tool '${tool}': ${message}`, { status: 500, cause: opts.cause });
  }
}

export class ToolDeniedError extends AiosError {
  constructor(tool: string, reason: string) {
    super("tool_denied", `tool '${tool}' denied: ${reason}`, { status: 403 });
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AiosError && err.retryable;
}
