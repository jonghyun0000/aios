import { AiosError, ProviderError, isRetryable } from "@aios/shared";
import type {
  CompletionRequest,
  ModelInfo,
  ProviderId,
  StreamEvent,
  TaskClass,
  Usage,
} from "@aios/shared";
import type { ProviderAdapter } from "./adapter.js";
import { MODEL_CATALOG, costUsd, findModel } from "./catalog.js";

export interface RouteConstraints {
  taskClass?: TaskClass;
  /** 특정 모델 고정 (사용자 명시 선택) */
  model?: string;
  needTools?: boolean;
  /** 프롬프트 추정 토큰 — 컨텍스트 윈도우 필터에 사용 */
  estimatedInputTokens?: number;
  maxCostUsd?: number;
}

export interface RouterOptions {
  catalog?: ModelInfo[];
  /** usage 발생 시 과금 파이프라인으로 흘리는 훅 */
  onUsage?: (info: { model: ModelInfo; usage: Usage }) => void;
}

/**
 * AI Router — 후보 필터링 → 점수화 → 폴백 실행.
 *
 * 가중치 설계 근거(docs/06-engines.md §11):
 * 코딩 에이전트에서 품질 실패(잘못된 편집)의 복구 비용 > 토큰 비용이므로 quality 최대 가중.
 * 단 taskClass가 cheap/summarize면 비용 축이 지배하도록 가중을 뒤집는다.
 */
export class AiRouter {
  private catalog: ModelInfo[];
  private health = new HealthTracker();

  constructor(
    private adapters: Partial<Record<ProviderId, ProviderAdapter>>,
    private opts: RouterOptions = {},
  ) {
    // 키가 설정된 프로바이더의 모델만 후보로 남긴다
    this.catalog = (opts.catalog ?? MODEL_CATALOG).filter((m) => adapters[m.provider]);
    if (this.catalog.length === 0) {
      throw new AiosError("no_providers", "no provider adapters configured", { status: 500 });
    }
  }

  rank(c: RouteConstraints): ModelInfo[] {
    if (c.model) {
      const m = findModel(c.model);
      if (!m || !this.adapters[m.provider]) {
        throw new AiosError("unknown_model", `model '${c.model}' unavailable`, { status: 400 });
      }
      return [m]; // 사용자가 고정한 모델은 폴백하지 않는다 — 명시 선택을 조용히 바꾸는 것은 배신
    }

    const cheapTask = c.taskClass === "cheap" || c.taskClass === "summarize";
    const est = c.estimatedInputTokens ?? 4000;

    const candidates = this.catalog.filter((m) => {
      if (c.needTools && !m.supportsTools) return false;
      if (est > m.contextWindow * 0.9) return false; // 10% 출력 여유
      if (c.maxCostUsd !== undefined && costUsd(m, est, 2000) > c.maxCostUsd) return false;
      if (this.health.isOpen(m)) return false;
      return true;
    });

    // 비용의 동적 범위는 모델 간 10~50배라, 선형 정규화된 비용에 큰 가중치를 주면
    // 품질 항(범위 ~0.5)을 항상 압도한다. 품질 우선 작업에서 비용 가중치가 0.10인 이유.
    const maxCost = Math.max(...candidates.map((m) => costUsd(m, est, 2000)), 1e-9);
    const scored = candidates.map((m) => {
      const quality = m.qualityTier / 3 + (c.taskClass && m.tags.includes(c.taskClass) ? 0.2 : 0);
      const cost = costUsd(m, est, 2000) / maxCost; // 0..1 정규화
      const latency = this.health.normLatency(m);
      const health = this.health.successRate(m);
      const score = cheapTask
        ? 0.15 * quality - 0.6 * cost - 0.15 * latency + 0.1 * health
        : 0.55 * quality - 0.1 * cost - 0.15 * latency + 0.1 * health;
      return { m, score };
    });

    return scored.sort((a, b) => b.score - a.score).map((s) => s.m);
  }

  /**
   * 폴백 스트리밍 실행.
   * 규칙: 첫 콘텐츠 이벤트가 나가기 전의 retryable 실패만 다음 후보로 투명 폴백.
   * 첫 토큰 이후의 실패는 정직하게 에러로 노출한다 — 모델을 중간에 바꿔 이어쓰면
   * 문체/판단이 뒤섞인 응답이 되고, 이는 조용한 실패라 디버깅도 불가능해진다.
   */
  async *stream(rawReq: Omit<CompletionRequest, "model">, c: RouteConstraints = {}): AsyncGenerator<StreamEvent> {
    const candidates = this.rank(c);
    if (candidates.length === 0) {
      throw new AiosError("no_candidates", "no model satisfies the constraints", { status: 400 });
    }

    // 저가 작업(요약·간단 질의)은 사고를 끈다: 사고 토큰은 출력 단가로 과금되므로
    // 요약에 사고를 붙이면 비용이 몇 배가 되고 지연도 늘어난다. 호출자가 명시하면 그것을 존중.
    const req: Omit<CompletionRequest, "model"> =
      rawReq.reasoning === undefined && (c.taskClass === "cheap" || c.taskClass === "summarize")
        ? { ...rawReq, reasoning: "off" }
        : rawReq;

    let lastErr: unknown;
    for (const model of candidates) {
      const adapter = this.adapters[model.provider]!;
      const modelReq = normalizeForModel(req, model);

      // 네트워크 계열 실패는 같은 모델로 잠깐 뒤에 다시 시도한다.
      // 다음 후보로 넘어가는 것만으로는 해결되지 않기 때문: 프로바이더가 하나뿐이면
      // 후보 모델이 달라도 같은 호스트로 나가고, 실제 측정에서 이 네트워크는
      // api.anthropic.com 연결의 8~17%를 무작위로 떨어뜨렸다.
      // 프로바이더가 돌려준 429/5xx는 여기서 재시도하지 않는다 — 그건 그 프로바이더의
      // 용량 문제이므로 다른 프로바이더로 넘어가는 편이 빠르고 옳다.
      for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
        const started = Date.now();
        let emitted = false;
        try {
          // routed는 '어떤 모델이 이 요청을 맡는가'를 알리는 이벤트다.
          // 같은 모델을 재시도할 때 다시 보내면 클라이언트 UI에 같은 모델이 여러 번 뜬다.
          // 모델이 바뀔 때만 알린다.
          if (attempt === 0) yield { type: "routed", provider: model.provider, model: model.id };
          for await (const ev of adapter.stream({ ...modelReq, model: model.id })) {
            if (ev.type === "text_delta" || ev.type === "tool_call") emitted = true;
            if (ev.type === "usage") {
              const usage: Usage = { ...ev.usage, costUsd: costUsd(model, ev.usage.inputTokens, ev.usage.outputTokens) };
              this.opts.onUsage?.({ model, usage });
              yield { type: "usage", usage };
              continue;
            }
            yield ev;
          }
          this.health.success(model, Date.now() - started);
          return;
        } catch (err) {
          // 사용자의 중단을 모델 장애로 세면 몇 번의 취소만으로 사용 가능한 모델이 사라진다.
          rawReq.abortSignal?.throwIfAborted();
          this.health.failure(model);
          lastErr = err;
          if (emitted || !isRetryable(err)) throw err;
          if (isNetworkError(err) && attempt < NETWORK_RETRIES) {
            await sleep(NETWORK_BACKOFF_MS[attempt]! * (0.75 + Math.random() * 0.5));
            continue; // 같은 모델로 재시도
          }
          break; // 다음 후보 모델로
        }
      }
    }
    // 마지막 원인을 메시지에 담는다. "every candidate model failed"만 남기면
    // 운영자는 크레딧 소진인지, 네트워크인지, 잘못된 요청인지 알 수 없다 —
    // cause 체인은 로그 포맷에 따라 유실되기도 하므로 메시지에 직접 넣는다.
    const reason = lastErr instanceof Error ? lastErr.message : "unknown error";
    throw new AiosError(
      "all_providers_failed",
      `every candidate model failed (${candidates.length} tried); last error: ${reason.slice(0, 300)}`,
      { status: 502, retryable: true, cause: lastErr },
    );
  }

  /** 임베딩: openai 우선, 없으면 gemini. (차원 1536으로 통일 — DB 스키마와 계약) */
  async embed(texts: string[]): Promise<number[][]> {
    // 로컬을 먼저 본다. 로컬 서버가 설정돼 있다는 것은 사용자가 외부 호출을 원치 않는다는
    // 뜻이고, 임베딩만 몰래 외부로 나가면 그 의도를 배신한다.
    const provider = this.adapters.local ?? this.adapters.openai ?? this.adapters.gemini;
    if (!provider?.embed) {
      throw new AiosError(
        "no_embedder",
        "no embedding-capable provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, " +
          "or LOCAL_LLM_BASE_URL (e.g. http://127.0.0.1:11434/v1 for Ollama).",
        { status: 500 },
      );
    }
    return provider.embed(texts);
  }

  snapshot() {
    return this.catalog.map((m) => ({
      model: m.id,
      provider: m.provider,
      open: this.health.isOpen(m),
      successRate: this.health.successRate(m),
      ewmaLatencyMs: this.health.ewma(m),
    }));
  }
}

/**
 * 사고가 켜진 모델에 보장해야 하는 최소 출력 예산.
 *
 * 근거(Phase 3 실측): claude-opus-5는 thinking이 기본 ON이고 max_tokens가 '사고 + 응답'을
 * 함께 제한한다. max_tokens=400으로 120단어를 요청하자 400 토큰이 전부 사고에 소진되어
 * 사용자에게 **빈 응답**이 나갔다(에러도 없이). 어댑터가 아니라 라우터에서 막는 이유:
 * 이 위험은 '모델의 성질'에 달려 있고, 모델을 아는 유일한 레이어가 라우터다.
 */
const THINKING_HEADROOM = 4096;

/**
 * 네트워크 계열 실패(호스트 도달 불가·DNS·TLS·리셋)에 대한 동일 모델 재시도 횟수와 백오프.
 * 짧게 잡는 이유: 진짜로 프로바이더가 죽었다면 빨리 다음 후보로 넘어가야 하고,
 * 잠깐의 연결 실패라면 수백 ms면 충분하다.
 */
const NETWORK_RETRIES = 2;
const NETWORK_BACKOFF_MS = [250, 750];

/** 응답을 받기 전 연결 단계에서 실패했는가 — 이 경우에만 같은 모델로 재시도한다 */
function isNetworkError(err: unknown): boolean {
  return err instanceof ProviderError && err.isConnectionFailure;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 선택된 모델의 제약에 맞게 요청을 정규화한다.
 *  - 샘플링 파라미터를 거부하는 모델에서 temperature 제거 (4.7+ Claude는 400)
 *  - 사고 기본 ON 모델에서 출력 예산이 빈약하면 상향 (빈 응답 방지)
 */
function normalizeForModel(req: Omit<CompletionRequest, "model">, model: ModelInfo): Omit<CompletionRequest, "model"> {
  const out: Omit<CompletionRequest, "model"> = { ...req };
  if (model.noSampling) out.temperature = undefined;
  if (model.thinksByDefault && req.reasoning !== "off") {
    const wanted = Math.max(out.maxTokens ?? 0, THINKING_HEADROOM);
    out.maxTokens = Math.min(wanted, model.maxOutput);
  }
  return out;
}

/**
 * 프로바이더:모델 단위 헬스 추적 + 서킷브레이커.
 * 임계: 30초 창에서 실패 5회 → open 60초 → half-open(1회 통과 허용).
 */
class HealthTracker {
  private stats = new Map<string, { fails: number[]; openUntil: number; ewmaMs: number; ok: number; total: number }>();

  private get(m: ModelInfo) {
    const key = `${m.provider}:${m.id}`;
    let s = this.stats.get(key);
    if (!s) {
      s = { fails: [], openUntil: 0, ewmaMs: 1500, ok: 0, total: 0 };
      this.stats.set(key, s);
    }
    return s;
  }

  success(m: ModelInfo, latencyMs: number) {
    const s = this.get(m);
    s.ok++;
    s.total++;
    s.fails = [];
    s.openUntil = 0;
    s.ewmaMs = s.ewmaMs * 0.8 + latencyMs * 0.2;
  }

  failure(m: ModelInfo) {
    const s = this.get(m);
    s.total++;
    const now = Date.now();
    s.fails = s.fails.filter((t) => now - t < 30_000);
    s.fails.push(now);
    if (s.fails.length >= 5) s.openUntil = now + 60_000;
  }

  isOpen(m: ModelInfo): boolean {
    const s = this.get(m);
    if (s.openUntil === 0) return false;
    if (Date.now() >= s.openUntil) {
      // half-open: 한 번의 시도를 허용
      s.openUntil = 0;
      s.fails = [];
      return false;
    }
    return true;
  }

  successRate(m: ModelInfo): number {
    const s = this.get(m);
    return s.total === 0 ? 1 : s.ok / s.total;
  }

  ewma(m: ModelInfo): number {
    return this.get(m).ewmaMs;
  }

  /** 0..1 정규화 지연 (10초를 상한으로 클램프) */
  normLatency(m: ModelInfo): number {
    return Math.min(this.get(m).ewmaMs / 10_000, 1);
  }
}
