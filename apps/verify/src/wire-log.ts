/**
 * 프로바이더 요청/응답 전량 로거.
 *
 * 왜 필요한가: LLM 검증의 실패는 대부분 "왜 이렇게 됐는지 모르겠다"로 끝난다.
 * 와이어 레벨 기록이 없으면 재현도, 프로바이더 문의도, 회귀 비교도 불가능하다.
 *
 * 안전장치: API 키와 Authorization 헤더는 절대 기록하지 않는다.
 * 로그 파일이 곧 유출 경로가 되는 사고가 실제로 흔하다.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface WireRecord {
  seq: number;
  ts: string;
  phase: string;
  direction: "request" | "response" | "error";
  url: string;
  method: string;
  status?: number;
  durationMs?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "cookie", "set-cookie"]);

function redactHeaders(h: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    out[k.toLowerCase()] = SECRET_HEADERS.has(k.toLowerCase()) ? "***REDACTED***" : v;
  }
  return out;
}

/**
 * globalThis.fetch를 감싸 모든 프로바이더 트래픽을 JSONL로 남긴다.
 * SSE 응답은 스트림을 tee 해서 원본 소비를 방해하지 않는다 —
 * 로깅이 동작을 바꾸면 그 로그는 증거로서 가치가 없다.
 */
export class WireLogger {
  private seq = 0;
  private original = globalThis.fetch;
  private installed = false;

  constructor(
    private file: string,
    private phase: string,
  ) {}

  async install(): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    this.installed = true;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const n = ++this.seq;
      const t0 = Date.now();

      await this.write({
        seq: n, ts: new Date().toISOString(), phase: this.phase, direction: "request",
        url, method,
        headers: redactHeaders(init?.headers as Record<string, string> | undefined),
        body: safeParse(init?.body),
      });

      try {
        const res = await this.original(input, init);
        const durationMs = Date.now() - t0;

        if (!res.body) {
          await this.write({
            seq: n, ts: new Date().toISOString(), phase: this.phase, direction: "response",
            url, method, status: res.status, durationMs, headers: redactHeaders(res.headers),
          });
          return res;
        }

        // tee: 한쪽은 호출자에게, 한쪽은 로그로. 원본 소비 타이밍에 영향을 주지 않는다.
        const [forCaller, forLog] = res.body.tee();
        void this.drainAndLog(forLog, { seq: n, url, method, status: res.status, durationMs, headers: redactHeaders(res.headers) });
        return new Response(forCaller, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch (err) {
        await this.write({
          seq: n, ts: new Date().toISOString(), phase: this.phase, direction: "error",
          url, method, durationMs: Date.now() - t0,
          body: { message: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    };
  }

  private async drainAndLog(
    stream: ReadableStream<Uint8Array>,
    meta: { seq: number; url: string; method: string; status: number; durationMs: number; headers: Record<string, string> },
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      /* 스트림이 중단(abort)될 수 있다 — 그때까지 받은 내용만 기록한다 */
    }
    await this.write({
      seq: meta.seq, ts: new Date().toISOString(), phase: this.phase, direction: "response",
      url: meta.url, method: meta.method, status: meta.status, durationMs: meta.durationMs,
      headers: meta.headers,
      // SSE 본문은 길다. 전량 보존하되 한 줄 JSON으로 — 나중에 jq로 뜯을 수 있게.
      body: text.length > 200_000 ? `${text.slice(0, 200_000)}…[truncated ${text.length - 200_000} chars]` : text,
    });
  }

  private async write(rec: WireRecord): Promise<void> {
    await appendFile(this.file, JSON.stringify(rec) + "\n", "utf8").catch(() => {});
  }

  uninstall(): void {
    if (this.installed) globalThis.fetch = this.original;
  }

  get count(): number {
    return this.seq;
  }
}

function safeParse(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body === undefined || body === null ? undefined : "[non-string body]";
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body.slice(0, 10_000);
  }
}
