import { Agent, fetch as undiciFetch } from "undici";
import type { CompletionRequest, ProviderId, StreamEvent } from "@aios/shared";
import { OpenAiAdapter } from "./openai.js";
import { ollamaStream } from "./ollama-stream.js";

/**
 * 로컬 추론 서버 어댑터 (Ollama / llama.cpp / LM Studio / vLLM).
 *
 * 왜 필요한가: 기존 어댑터는 전부 외부 유료 API를 전제한다. 그래서 API 키가 없으면
 * context.ts가 부팅을 거부하고, router.embed()는 no_embedder를 던진다.
 * 즉 "키 없이 내 데이터만으로" 쓰려면 제품이 아예 기동하지 않았다.
 *
 * 구현이 base URL 교체뿐인 이유: 위 런타임들은 모두 OpenAI Chat Completions/Embeddings
 * 호환 API를 노출한다. xai.ts가 같은 이유로 같은 방식을 쓴다. 호환 API를 재구현하면
 * 두 코드 경로가 서로 다르게 썩는다 — 비호환이 생기는 지점에서만 오버라이드한다.
 *
 * API 키: 로컬 서버는 인증이 없지만 OpenAI 클라이언트가 Authorization 헤더를 요구하는
 * 경우가 있어 더미 값을 넣는다. 네트워크를 벗어나지 않으므로 비밀이 아니다.
 */
/**
 * 로컬 임베딩 서버에 동시에 던질 최대 요청 수.
 *
 * 실측(bge-m3, MacBook Air, 64건). 동시성을 낮은 쪽→높은 쪽, 높은 쪽→낮은 쪽 두 순서로 재
 * 순서 효과를 걸러 냈다:
 *
 *   동시성   p95(정순/역순)      처리량(정순/역순)
 *        1    77ms /   85ms      13.7 / 13.4 /s
 *        4   164ms /  169ms      26.4 / 28.3 /s   ← 처리량이 여기서 포화한다
 *        8   512ms /  271ms      21.9 / 32.0 /s
 *       25  1145ms /  759ms      23.3 / 32.2 /s
 *
 * 읽는 법:
 *  - **처리량은 4 근처에서 포화한다.** 더 올려도 얻는 게 없다(실행 간 편차 안에 묻힌다).
 *  - **지연은 동시성에 비례해 나빠진다.** 4 → 25 에서 p95 가 5~7배가 된다.
 *
 * 그래서 4로 묶는다: 처리량은 잃지 않고, 추론 서버에 쌓이는 큐 깊이를 예측 가능하게 만들며,
 * 같은 서버를 쓰는 채팅 요청이 임베딩에 굶지 않는다.
 *
 * **이것이 대량 임베딩을 빠르게 만들지는 않는다.** 한 호출자가 25건을 동시에 던지면
 * 대기가 서버 큐에서 우리 큐로 옮겨올 뿐이고 전체 시간은 그대로다(실측 2692ms → 2605ms).
 * 로컬 임베더의 천장은 ~30 텍스트/s 이고, 그것은 CPU 위의 모델 자체가 정한다 —
 * 클라이언트 쪽에서 올릴 방법이 없다.
 *
 * 배치(여러 텍스트를 한 요청에)도 재 봤지만 더 느렸다 (배치 8건 31.6/s vs 동시 4건 36.9/s).
 * Ollama 는 이미 요청 단위로 병렬 처리하고, 배치 하나는 한 슬롯 안에서 순차 처리된다.
 *
 * 외부 프로바이더에는 걸지 않는다 — 그쪽은 서버 측에서 알아서 확장한다.
 */
const DEFAULT_EMBED_CONCURRENCY = 4;

/**
 * 동시에 진행할 최대 **생성(chat)** 요청 수.
 *
 * 왜 필요한가 — 실측으로 드러난 실제 장애:
 *
 *   PHASE 6, 동시성 6으로 12개 스트림:
 *     n=10/12 err=2
 *     lastError="[local] network failure: fetch failed (UND_ERR_HEADERS_TIMEOUT)"
 *     TTFT p50=343초
 *
 * undici(Node 내장 fetch)의 기본 **헤더 타임아웃은 300초**다. 로컬 서버는 용량을 넘는
 * 요청을 받아 두고 순서를 기다리게 하는데, 그동안 응답 헤더를 보내지 않는다.
 * 그래서 TTFT 가 300초를 넘는 순간 요청이 네트워크 오류로 죽는다 —
 * **서버는 멀쩡하고 우리 요청도 정당한데, 줄을 서 있었다는 이유만으로.**
 *
 * 우리 프로세스에서 줄을 세우면 그 대기는 HTTP 타임아웃 대상이 아니다.
 * 슬롯이 났을 때 비로소 연결을 열므로 헤더가 곧바로 온다.
 * 전체 소요 시간은 같다 — 바뀌는 것은 **죽느냐 기다리느냐**다.
 *
 * 기본 2 — 다만 이제 이것은 **충돌 방지가 아니라 지연·처리량 조절 손잡이**다.
 * 헤더 타임아웃을 껐으므로(아래 localDispatcher) 상한을 넘겨도 죽지 않고 느려질 뿐이다.
 *
 * 실측(M4, qwen3:8b, 12건):
 *   동시성 2  TTFT p50  65.4s  최대 107.2s  전체 440.6s
 *   동시성 4  TTFT p50 114.5s  최대 150.5s  전체 410.9s  ← 전체시간 최선
 *   동시성 6  TTFT p50 244.7s  최대 278.6s  전체 492.9s  ← 얻는 것 없이 나빠진다
 *
 * 더 느린 기기(MacBook Air)에서는 c=6 이 TTFT p50 343초로 아예 실패했다.
 * 기본값은 느린 쪽에 맞춘다 — 빠른 기기는 위 표를 보고 올리면 된다.
 */
const DEFAULT_CHAT_CONCURRENCY = 2;

/**
 * 로컬 추론용 HTTP 디스패처.
 *
 * **왜 내장 fetch 를 쓰지 않는가:** Node 내장 fetch 는 undici 기본값을 쓰고
 * 헤더 타임아웃이 300초로 고정돼 있으며 설정할 방법이 없다. 로컬 서버는 요청을 받아 두고
 * 순서를 기다리게 하는 동안 응답 헤더를 보내지 않으므로, 대기가 300초를 넘으면
 * `UND_ERR_HEADERS_TIMEOUT` 으로 죽는다 — 서버도 요청도 멀쩡한데.
 *
 * 동시성 상한으로 대기를 줄일 수는 있지만 **없앨 수는 없다.** 더 큰 모델(70B CPU)이나
 * 부하가 걸린 기기에서는 동시성 1에서도 첫 토큰이 300초를 넘는다. 그러면 그 모델은
 * 아예 쓸 수 없게 된다 — 상한을 어떻게 잡아도.
 *
 * 그래서 타임아웃 자체를 끈다. 로컬 추론에서 "오래 걸림"은 오류가 아니다.
 * 실제 취소는 호출자의 AbortSignal 이 담당한다(요청마다 다르므로 그게 옳은 자리다).
 *
 * npm undici 의 fetch 를 쓰는 이유: 내장 fetch 는 npm undici 의 Agent 를 **거부한다**
 * (`UND_ERR_INVALID_ARG`). 두 undici 인스턴스는 호환되지 않으므로 한쪽으로 통일해야 한다.
 * 클라우드 어댑터는 내장 fetch 를 그대로 쓴다 — 거기서는 300초 상한이 올바른 방어다.
 */
const localDispatcher = new Agent({
  headersTimeout: 0, // 첫 응답까지 무제한 — 대기는 정상이다
  bodyTimeout: 0, // 토큰 사이 간격도 제한하지 않는다
  connectTimeout: 10_000, // 다만 '서버가 없음'은 빨리 알아야 한다
});

export class LocalAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = "local";

  protected override toWire(req: CompletionRequest): Record<string, unknown> {
    // Ollama의 /v1 호환 API는 think:false가 아니라 reasoning_effort:none을 받는다.
    // https://docs.ollama.com/api/openai-compatibility
    // 기존에는 reasoning:"off"가 직렬화 과정에서 사라져, 간단한 질문도 긴 사고를 했다.
    return { ...super.toWire(req), ...(req.reasoning === "off" ? { reasoning_effort: "none" } : {}) };
  }

  private readonly embedModel: string;
  private readonly embedLimit: number;
  private readonly chatLimit: number;
  /** 게이트 두 개를 따로 둔다 — 임베딩 폭주가 채팅을 굶기면 안 되고, 그 반대도 마찬가지다. */
  private readonly embedGate = { inFlight: 0, waiters: [] as (() => void)[] };
  private readonly chatGate = { inFlight: 0, waiters: [] as (() => void)[] };

  constructor(
    baseUrl: string,
    embedModel = "bge-m3",
    apiKey = "local-no-auth",
    embedConcurrency = DEFAULT_EMBED_CONCURRENCY,
    chatConcurrency = DEFAULT_CHAT_CONCURRENCY,
    private readonly protocol: "openai" | "ollama" = "openai",
    private readonly contextWindow?: number,
  ) {
    super(apiKey);
    // 끝의 슬래시를 제거한다. 사용자가 ".../v1/"로 넣으면 ".../v1//chat/completions"가 되어
    // 일부 서버가 404를 낸다.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.embedModel = embedModel;
    this.embedLimit = Math.max(1, embedConcurrency);
    this.chatLimit = Math.max(1, chatConcurrency);
    // 타입만 맞춘다 — undici 의 fetch 는 표준 fetch 와 시그니처가 미묘하게 다르지만
    // 우리가 쓰는 범위(url, method, headers, body, signal, Response.body)는 동일하다.
    this.fetchImpl = ((url: string | URL | Request, init?: RequestInit) =>
      undiciFetch(url as string, { ...(init as object), dispatcher: localDispatcher })) as unknown as typeof fetch;
  }

  /** 슬롯을 하나 잡는다. 없으면 날 때까지 기다린다. */
  private async acquire(gate: { inFlight: number; waiters: (() => void)[] }, limit: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (gate.inFlight < limit) {
      gate.inFlight++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = gate.waiters.indexOf(wake);
        if (index !== -1) gate.waiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("request cancelled"));
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        // 슬롯을 깨우는 순간 예약해 새 요청이 먼저 차지하지 못하게 한다.
        gate.inFlight++;
        resolve();
      };
      gate.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(gate: { inFlight: number; waiters: (() => void)[] }): void {
    gate.inFlight--;
    // 순서를 보존한다(FIFO). LIFO 면 붐빌 때 먼저 온 요청이 계속 밀려 꼬리 지연이 폭발한다.
    gate.waiters.shift()?.();
  }

  /**
   * 생성 요청도 슬롯을 잡는다.
   *
   * finally 로 반납하는 것이 중요하다 — 소비자가 도중에 멈추면(break/throw) 제너레이터가
   * return() 으로 종료되는데, 그때도 슬롯이 돌아와야 한다. 안 그러면 취소 몇 번에
   * 게이트가 영구히 막힌다.
   */
  override async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const queued = performance.now();
    await this.acquire(this.chatGate, this.chatLimit, req.abortSignal);
    try {
      req.abortSignal?.throwIfAborted();
      yield { type: "timing", phase: "client_queue", durationMs: performance.now() - queued };
      if (this.protocol === "ollama") yield* ollamaStream(this.fetchImpl, this.baseUrl, this.headers(), req, this.contextWindow);
      else yield* super.stream(req);
    } finally {
      this.release(this.chatGate);
    }
  }

  /**
   * 임베딩 모델 기본값을 바꾼다.
   * 상위 클래스의 기본값은 OpenAI의 text-embedding-3-small인데, 로컬 서버에는
   * 그런 모델이 없어 404가 난다. 호출부가 모델명을 몰라도 되도록 여기서 갈아끼운다.
   */
  override async embed(texts: string[], model = this.embedModel): Promise<number[][]> {
    await this.acquire(this.embedGate, this.embedLimit);
    try {
      return await super.embed(texts, model);
    } finally {
      // 실패해도 슬롯은 반드시 돌려준다. 안 그러면 한 번의 오류로 임베딩이 영구히 막힌다.
      this.release(this.embedGate);
    }
  }
}
