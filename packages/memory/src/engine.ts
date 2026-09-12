import type { ChatMessage, MemoryScope } from "@aios/shared";
import { ShortTermMemory } from "./short-term.js";
import { LongTermMemory } from "./long-term.js";

/**
 * Memory Engine — STM/LTM 오케스트레이터.
 *
 * LLM 의존(요약·사실 추출)은 전부 함수 주입: memory 패키지는 @aios/ai를 모른다.
 * 이유: 순환 의존 차단 + 테스트에서 LLM 없이 결정론적으로 검증 가능.
 */

export interface MemoryContext {
  stmSummary: string | null;
  history: ChatMessage[];
  facts: string[]; // "[kind] content" 포맷
}

export type SummarizeFn = (existing: string | null, messages: ChatMessage[]) => Promise<string>;
export type ExtractFactsFn = (messages: ChatMessage[]) => Promise<ExtractedFact[]>;

export class MemoryEngine {
  constructor(
    public readonly stm: ShortTermMemory,
    public readonly ltm: LongTermMemory,
    private fns: { summarize: SummarizeFn; extractFacts: ExtractFactsFn },
  ) {}

  /** 요청 경로: STM 윈도우와 LTM recall을 병렬로 — TTFT에 더해지는 비용은 max(둘) */
  async buildContext(scope: MemoryScope, sessionId: string, query: string, options: { useLongTermMemory?: boolean } = {}): Promise<MemoryContext> {
    const [window, items] = await Promise.all([
      this.stm.getWindow(sessionId),
      options.useLongTermMemory === false ? Promise.resolve([]) : this.ltm.recall(scope, query).catch(() => []),
    ]);
    return {
      stmSummary: window.summary,
      history: window.messages,
      facts: items.map((i) => `[${i.kind}] ${i.content}`),
    };
  }

  async record(sessionId: string, message: ChatMessage): Promise<void> {
    await this.stm.append(sessionId, message);
  }

  /** 백그라운드 잡 전용 — 응답 경로에서 호출 금지 */
  async maybeCompact(sessionId: string): Promise<void> {
    if (await this.stm.needsCompaction(sessionId)) {
      await this.stm.compact(sessionId, this.fns.summarize);
    }
  }

  /** 백그라운드 잡: 대화에서 오래 기억할 가치가 있는 사실을 추출해 LTM에 적재 */
  async extractAndStore(scope: MemoryScope, sessionId: string, messages: ChatMessage[]): Promise<number> {
    const facts = await this.fns.extractFacts(messages);
    let stored = 0;
    for (const f of facts) {
      await this.ltm.remember(scope, {
        kind: f.kind,
        content: f.content,
        importance: f.importance,
        sourceSessionId: sessionId,
      });
      stored++;
    }
    return stored;
  }
}

/** 추출이 만들어도 되는 kind — DB의 memory_items_kind_check 와 같은 집합이어야 한다. */
const EXTRACTABLE_KINDS = ["fact", "preference", "decision"] as const;
type ExtractedKind = (typeof EXTRACTABLE_KINDS)[number];

export interface ExtractedFact {
  kind: ExtractedKind;
  content: string;
  importance: number;
}

/** 한 사실의 content 상한. 임베딩 비용과 저장 낭비를 막는다. */
const MAX_FACT_CHARS = 2_000;

/**
 * 모델이 낸 텍스트를 사실 목록으로 바꾼다.
 *
 * **왜 여기서 검증하는가:** 이전에는 호출부가 `Array.isArray(parsed) ? parsed : []` 만 보고
 * 항목 내용을 그대로 DB 에 넣었다. 배열이기만 하면 `kind` 든 `importance` 든 모델이 준 값이
 * 그대로 INSERT 됐다는 뜻이다. 실제로 로컬 모델이 집합 밖의 kind 를 내면서 이렇게 터졌다:
 *
 *   new row for relation "memory_items" violates check constraint "memory_items_kind_check"
 *
 * 그리고 그 예외가 세션 전체를 죽였다 — 호출부 주석은 "추출 실패는 치명적이지 않다" 였는데
 * 실제로는 치명적이었다. JSON 파싱 실패만 막고 있었기 때문이다.
 *
 * 모델 출력은 **데이터이지 명령이 아니다.** 스키마에 닿기 전에 경계에서 좁힌다.
 * 판정 규칙:
 *  - kind 가 집합 밖이면 버리지 않고 `fact` 로 둔다 — 분류가 틀렸다고 사실이 사라질 이유는 없다.
 *  - content 가 문자열이 아니거나 비어 있으면 **버린다** — 내용 없는 기억은 잡음일 뿐이다.
 *  - importance 는 0..1 로 조인다. 숫자가 아니면 0.5.
 *
 * 호출부가 두 곳(프로덕션 조립부와 검증 하네스)이라 각자 구현하면 반드시 갈라진다.
 */
export function parseExtractedFacts(raw: string): ExtractedFact[] {
  let parsed: unknown;
  try {
    // 모델이 코드펜스로 감싸는 경우가 흔하다.
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return []; // 파싱 실패는 치명적이지 않다 — 다음 세션에서 다시 기회가 온다
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedFact[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;

    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) continue;

    const rawKind = typeof row.kind === "string" ? row.kind.trim().toLowerCase() : "";
    const kind = (EXTRACTABLE_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as ExtractedKind)
      : "fact";

    const n = Number(row.importance);
    const importance = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;

    out.push({ kind, content: content.slice(0, MAX_FACT_CHARS), importance });
  }
  return out;
}

/** 사실 추출 프롬프트 — 워커에서 저가 모델과 함께 사용 */
export const EXTRACT_FACTS_PROMPT = `Extract durable facts worth remembering from this conversation.
Include: user preferences, project decisions, recurring constraints, corrections the user made.
Exclude: transient task details, anything derivable from the codebase itself.
Respond with a JSON array: [{"kind":"fact|preference|decision","content":"...","importance":0.0-1.0}]
Return [] if nothing is worth remembering. JSON only.`;
