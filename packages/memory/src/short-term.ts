import type { Redis } from "ioredis";
import { estimateTokens } from "@aios/shared";
import type { ChatMessage } from "@aios/shared";

/**
 * Short-term Memory — 세션 단위 대화 윈도우.
 *
 * Redis를 쓰는 이유: 매 요청 hot path에 있으므로 p99 1ms급이 필요하고,
 * 세션 종료 후 가치가 급감하므로 TTL 자연 소멸이 올바른 수명 모델이다.
 *
 * 키 설계: {stm:<sessionId>} 해시태그 — Redis Cluster 이행 시 세션의 모든 키가
 * 같은 슬롯에 배치되어 MULTI/파이프라인이 계속 동작한다.
 */

export interface StmWindow {
  summary: string | null;
  messages: ChatMessage[];
  /** 메시지 + rolling summary 합계. 둘 다 프롬프트 예산을 소비하므로 함께 센다. */
  approxTokens: number;
}

export interface StmOptions {
  maxTokens?: number; // 윈도우 예산
  ttlSeconds?: number;
  /**
   * 예산 중 rolling summary가 차지할 수 있는 최대 비율.
   * 요약을 제한하지 않으면 요약만으로 예산을 넘겨 압축이 임계를 영원히 해소하지 못한다
   * (아래 needsCompaction 주석의 thrash 참조).
   */
  summaryBudgetRatio?: number;
}

const DEFAULTS = { maxTokens: 8_000, ttlSeconds: 7 * 24 * 3600, summaryBudgetRatio: 0.3 };

/** 압축이 의미를 가지려면 요약할 메시지가 최소 이만큼은 있어야 한다 */
const MIN_MESSAGES_TO_COMPACT = 4;

export class ShortTermMemory {
  private maxTokens: number;
  private ttl: number;
  private summaryBudgetRatio: number;

  constructor(
    private redis: Redis,
    opts: StmOptions = {},
  ) {
    this.maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    this.ttl = opts.ttlSeconds ?? DEFAULTS.ttlSeconds;
    this.summaryBudgetRatio = opts.summaryBudgetRatio ?? DEFAULTS.summaryBudgetRatio;
  }

  /** 요약에 허용된 토큰 예산 */
  get summaryTokenBudget(): number {
    return Math.floor(this.maxTokens * this.summaryBudgetRatio);
  }

  private listKey(sessionId: string) {
    return `{stm:${sessionId}}:msgs`;
  }
  private sumKey(sessionId: string) {
    return `{stm:${sessionId}}:summary`;
  }

  async append(sessionId: string, message: ChatMessage): Promise<void> {
    const pipe = this.redis.pipeline();
    pipe.rpush(this.listKey(sessionId), JSON.stringify(message));
    pipe.expire(this.listKey(sessionId), this.ttl);
    pipe.expire(this.sumKey(sessionId), this.ttl);
    await pipe.exec();
  }

  async getWindow(sessionId: string): Promise<StmWindow> {
    const [raw, summary] = await Promise.all([
      this.redis.lrange(this.listKey(sessionId), 0, -1),
      this.redis.get(this.sumKey(sessionId)),
    ]);
    const messages = raw.map((r) => JSON.parse(r) as ChatMessage);
    // summary도 매 요청 프롬프트에 실려 나가므로 예산 계산에 반드시 포함해야 한다.
    // 빠뜨리면 요약이 누적될수록 실제 사용량이 예산을 조용히 초과한다.
    const approxTokens =
      messages.reduce((s, m) => s + estimateTokens(m.content), 0) + estimateTokens(summary ?? "");
    return { summary, messages, approxTokens };
  }

  /**
   * 임계 80%에서 true — 압축을 '선제적으로' 백그라운드에서 돌리기 위한 신호.
   * 100%가 되어 hot path에서 압축하면 그 요청의 지연이 요약 LLM 호출만큼 늘어난다.
   *
   * 두 번째 조건(메시지 수)이 핵심이다: compact()는 '메시지의 오래된 절반'만 요약한다.
   * 남은 메시지가 몇 개 없으면 압축해도 토큰이 줄지 않는데, 토큰만 보고 true를 돌려주면
   * 매 턴 요약 LLM이 호출되는 스래싱이 된다 — 500턴 스트레스에서 압축이 491회 실행되는
   * 것을 실측했다(턴당 1회꼴). 압축으로 실제로 줄일 것이 있을 때만 신호를 낸다.
   */
  async needsCompaction(sessionId: string): Promise<boolean> {
    const { approxTokens, messages } = await this.getWindow(sessionId);
    if (messages.length < MIN_MESSAGES_TO_COMPACT) return false;
    return approxTokens > this.maxTokens * 0.8;
  }

  /**
   * 오래된 절반을 요약해 rolling summary에 병합하고 리스트에서 제거한다.
   * summarize는 주입받는다 — 메모리 패키지가 AI 패키지에 의존하지 않게 하는 의존성 역전.
   */
  async compact(
    sessionId: string,
    summarize: (existingSummary: string | null, messages: ChatMessage[]) => Promise<string>,
  ): Promise<void> {
    const { summary, messages } = await this.getWindow(sessionId);
    if (messages.length < MIN_MESSAGES_TO_COMPACT) return;
    const half = Math.floor(messages.length / 2);
    const oldHalf = messages.slice(0, half);

    const newSummary = await summarize(summary, oldHalf);

    // 요약은 반드시 예산 안으로 자른다.
    // summarize()는 주입된 함수 — LLM일 수도, 서드파티 구현일 수도 있다. 반환 길이를
    // 신뢰하면 요약 하나가 윈도우 전체를 삼켜 압축이 무의미해진다(실측된 스래싱의 원인).
    // 자를 때 앞이 아니라 뒤를 버리는 이유: 요약문은 보통 앞쪽에 결론·결정이 온다.
    const capped = this.capToBudget(newSummary);

    // 요약 생성 중 새 메시지가 append 되었을 수 있으므로 정확히 half개만 앞에서 제거
    const pipe = this.redis.pipeline();
    pipe.ltrim(this.listKey(sessionId), half, -1);
    pipe.set(this.sumKey(sessionId), capped, "EX", this.ttl);
    await pipe.exec();
  }

  /**
   * 요약을 summaryTokenBudget 이내로 자른다.
   * 주의: 잘라냈다는 표시 문구도 프롬프트에 실려 나가므로 예산에 포함해서 계산해야 한다.
   * (표시 문구를 뺀 채 재다가 최종 결과가 예산을 넘긴 버그를 실제로 겪었다.)
   */
  private capToBudget(summary: string): string {
    const budget = this.summaryTokenBudget;
    if (estimateTokens(summary) <= budget) return summary;

    const notice = `…[summary truncated to fit the ${budget}-token budget]`;
    const allowance = Math.max(16, budget - estimateTokens(notice));
    // 추정기의 라틴 계수(2.7 chars/token)를 역으로 적용해 문자 상한을 잡고,
    // 예산 안에 들어올 때까지 줄인다(CJK가 섞이면 문자당 토큰이 커지므로 반복 축소).
    let cut = Math.floor(allowance * 2.7);
    let out = summary.slice(0, cut);
    while (cut > 16 && estimateTokens(out) > allowance) {
      cut = Math.floor(cut * 0.8);
      out = summary.slice(0, cut);
    }
    return out + notice;
  }

  async clear(sessionId: string): Promise<void> {
    await this.redis.del(this.listKey(sessionId), this.sumKey(sessionId));
  }
}
