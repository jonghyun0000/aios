import type { AgentEvent, CodeChunkHit, MemoryItem, TaskClass } from "@aios/shared";

/**
 * AIOS SDK — 서버 API의 타입 안전 클라이언트.
 * 의존성 0 (fetch/EventSource 파싱 자체 구현): SDK는 사용자의 앱에 들어가는 코드다.
 * 의존성 하나하나가 사용자의 감사·번들 비용이 된다.
 */

export interface AiosClientOptions {
  baseUrl?: string;
  apiKey: string;
  orgId?: string;
  fetchImpl?: typeof fetch;
}

export interface SendMessageOptions {
  taskClass?: TaskClass;
  model?: string;
  maxCostUsd?: number;
  toolsEnabled?: boolean;
  useRag?: boolean;
  useMemory?: boolean;
  projectRoot?: string;
  signal?: AbortSignal;
}

export class AiosClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private fetch: typeof fetch;

  constructor(opts: AiosClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.aios.dev").replace(/\/$/, "");
    this.headers = {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(opts.orgId ? { "x-org-id": opts.orgId } : {}),
    };
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const err = (detail as { error?: { code?: string; message?: string } }).error;
      throw new AiosApiError(err?.code ?? `http_${res.status}`, err?.message ?? res.statusText, res.status);
    }
    return (await res.json()) as T;
  }

  async createSession(input: { projectId?: string; title?: string } = {}): Promise<{ id: string }> {
    return this.request("POST", "/v1/sessions", input);
  }

  /** 메시지 전송 — AgentEvent 비동기 이터레이터 반환 */
  async *sendMessage(sessionId: string, content: string, opts: SendMessageOptions = {}): AsyncGenerator<AgentEvent> {
    const res = await this.fetch(`${this.baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { ...this.headers, accept: "text/event-stream" },
      body: JSON.stringify({
        content,
        routing: { taskClass: opts.taskClass, model: opts.model, maxCostUsd: opts.maxCostUsd },
        tools: { enabled: opts.toolsEnabled ?? true },
        context: {
          useRag: opts.useRag ?? true,
          useMemory: opts.useMemory ?? true,
          projectRoot: opts.projectRoot,
        },
      }),
      signal: opts.signal ?? null,
    });
    if (!res.ok || !res.body) {
      throw new AiosApiError(`http_${res.status}`, await res.text().catch(() => res.statusText), res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as AgentEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async search(projectId: string, query: string, k = 8): Promise<CodeChunkHit[]> {
    const res = await this.request<{ hits: CodeChunkHit[] }>(
      "GET",
      `/v1/projects/${projectId}/search?q=${encodeURIComponent(query)}&k=${k}`,
    );
    return res.hits;
  }

  async remember(input: {
    kind: "fact" | "preference" | "decision";
    content: string;
    projectId?: string;
  }): Promise<{ id: string; deduped: boolean }> {
    return this.request("POST", "/v1/memory", input);
  }

  async recallMemory(query: string, projectId?: string): Promise<MemoryItem[]> {
    const qs = new URLSearchParams({ q: query, ...(projectId ? { projectId } : {}) });
    const res = await this.request<{ items: MemoryItem[] }>("GET", `/v1/memory?${qs}`);
    return res.items;
  }

  async triggerIndex(projectId: string, rootDir: string): Promise<{ jobId: string }> {
    return this.request("POST", `/v1/projects/${projectId}/index`, { rootDir });
  }

  async models(): Promise<unknown> {
    return this.request("GET", "/v1/models");
  }
}

export class AiosApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "AiosApiError";
  }
}
