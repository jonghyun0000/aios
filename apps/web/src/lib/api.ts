/**
 * API 클라이언트.
 *
 * 설계 결정:
 *  1) 인증은 기본적으로 **쿠키**다(`credentials: "include"`). 세션 토큰을 localStorage에
 *     넣으면 XSS 한 방에 탈취된다. HttpOnly 쿠키는 JS가 읽을 수 없다.
 *  2) 다만 자체 호스팅/로컬에서는 OAuth 프로바이더가 설정되지 않았을 수 있다.
 *     그때를 위해 API 키 로그인을 별도 경로로 허용하되, 키는 sessionStorage에만 두고
 *     (탭을 닫으면 사라진다) UI가 "이 방식은 안전성이 낮다"고 명시한다.
 *  3) 에러는 서버의 구조화된 형태({error:{code,message}})를 그대로 보존해
 *     화면이 코드에 따라 다르게 반응할 수 있게 한다. 문자열로 뭉개면 그게 불가능하다.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** 로그인 화면으로 보내야 하는가 */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === "auth_error";
  }
}

const API_KEY_STORAGE = "aios.apiKey";

/**
 * API 키 보관소.
 *
 * sessionStorage와 localStorage 중 **사용자가 고른다**. 그 이유:
 * 둘 다 같은 오리진의 스크립트가 읽을 수 있어 XSS 방어력에는 차이가 없다.
 * 실제 차이는 수명뿐이다 — sessionStorage는 탭을 닫으면 사라지고(공용 PC에 유리),
 * localStorage는 남는다(탭을 여러 개 쓰는 개발자에게 유리).
 * 기본값은 세션 한정이되, 새 탭마다 다시 로그인하는 마찰을 감수할지는 사용자가 정한다.
 *
 * 어느 쪽이든 HttpOnly 쿠키(OAuth)보다는 약하다. 그래서 UI가 OAuth를 권한다.
 */
export const apiKeyStore = {
  get(): string | null {
    return sessionStorage.getItem(API_KEY_STORAGE) ?? localStorage.getItem(API_KEY_STORAGE);
  },
  set(key: string, remember = false): void {
    // 반대편 저장소를 반드시 비운다. 남겨두면 "로그아웃했는데 새로고침하니 다시 로그인됨"이 된다.
    const [target, other] = remember
      ? [localStorage, sessionStorage]
      : [sessionStorage, localStorage];
    target.setItem(API_KEY_STORAGE, key);
    other.removeItem(API_KEY_STORAGE);
  },
  clear(): void {
    sessionStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(API_KEY_STORAGE);
  },
  /** 설정 화면이 "지금 어디에 저장돼 있는지"를 정확히 말할 수 있게 한다. */
  location(): "session" | "local" | null {
    if (sessionStorage.getItem(API_KEY_STORAGE)) return "session";
    if (localStorage.getItem(API_KEY_STORAGE)) return "local";
    return null;
  },
};

function authHeaders(): Record<string, string> {
  const key = apiKeyStore.get();
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function parseError(res: Response): Promise<never> {
  const text = await res.text();
  let code = "http_error";
  let message = `${res.status} ${res.statusText}`;
  let details: unknown;
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    if (text) message = text.slice(0, 300);
  }
  throw new ApiError(res.status, code, message, details);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/**
 * WebSocket용 토큰.
 * 브라우저 WS API는 커스텀 헤더를 붙일 수 없어 서버가 query token을 받는다.
 * 쿠키 세션이면 같은 오리진이라 브라우저가 알아서 쿠키를 보내므로 토큰이 필요 없다.
 */
export function wsTokenParam(): string {
  const key = apiKeyStore.get();
  return key ? `&token=${encodeURIComponent(key)}` : "";
}

// ---------- 도메인 타입 (서버 응답의 실제 형태) ----------

export interface Me {
  orgId: string;
  userId: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  via: "jwt" | "api_key" | "session" | "local";
  workspaceRoot?: string | null;
}

export interface SessionRow {
  id: string;
  title: string | null;
  updated_at: string;
  project_id?: string | null;
  project_name?: string | null;
  deleted_at?: string | null;
}

/**
 * 저장된 메시지.
 *
 * `content`는 문자열이 아니라 jsonb 블록이다: `{ text, toolCalls?, toolCallId? }`.
 * 이걸 문자열로 가정하고 그대로 렌더링하면 React가 "Objects are not valid as a React child"로
 * 죽는다 — 실제로 이 UI를 처음 붙였을 때 앱 전체가 백지가 됐다.
 * 그래서 타입을 정확히 선언하고 messageText()로만 꺼내 쓴다.
 */
export interface MessageContent {
  text?: string;
  toolCalls?: { id: string; name: string; arguments?: Record<string, unknown> }[] | null;
  toolCallId?: string;
}

export interface MessageRow {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent | string | null;
  created_at: string;
}

/**
 * 어떤 형태로 오든 사람이 읽을 문자열을 돌려준다.
 * 서버 스키마가 바뀌어도 화면이 죽지 않는 것이 목표다 — 알 수 없는 형태는
 * 빈 문자열이 아니라 JSON으로 보여준다. 조용히 사라지면 디버깅이 불가능해진다.
 */
export function messageText(content: MessageRow["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

export function messageToolCalls(content: MessageRow["content"]): { id: string; name: string }[] {
  if (content == null || typeof content === "string") return [];
  return content.toolCalls ?? [];
}

/**
 * 라우터가 노출하는 모델 상태.
 * `open`은 서킷 브레이커가 열렸다는 뜻이다(= 연속 실패로 이 모델을 잠시 제외 중).
 * 즉 사용 가능 여부는 `!open`이다 — 필드 이름이 부정형이라 화면에서 뒤집어 쓴다.
 */
export interface ModelSnapshot {
  model: string;
  provider: string;
  open: boolean;
  successRate: number;
  ewmaLatencyMs: number;
}

export interface PlanRow {
  id: string;
  name: string;
  monthly_price_cents: number;
  included_tokens: string;
  limits: Record<string, unknown>;
}

export interface SubscriptionView {
  subscription: {
    plan_id: string;
    plan_name: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    has_payment_method: boolean;
    monthly_price_cents: number;
    included_tokens: string;
  };
  usage: { tokens: number; includedTokens: number; percentUsed: number | null; costCents: number };
}

export interface PluginRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  downloads: string;
  keywords: string[];
  homepage: string | null;
  visibility: string;
  latest_version: string | null;
  rating: string;
  rating_count: string;
}

export interface PluginVersionRow {
  id: string;
  version: string;
  status: "pending" | "approved" | "rejected";
  bundle_url: string;
  bundle_sha256: string;
  signed: boolean;
  manifest: { permissions?: string[]; contributes?: { tools?: { name: string; description: string }[] } };
  created_at: string;
}

export interface InstalledRow {
  slug: string;
  name: string;
  version: string;
  enabled: boolean;
  granted_permissions: string[];
  created_at: string;
}
