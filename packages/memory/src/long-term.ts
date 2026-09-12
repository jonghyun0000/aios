import type { Pool } from "pg";
import type { MemoryItem, MemoryKind, MemoryScope } from "@aios/shared";

/**
 * Long-term Memory — pgvector 기반 영속 기억.
 *
 * recall 점수 = 0.6·cosine + 0.25·importance + 0.15·recency(반감기 30일)
 * 순수 유사도만 쓰면 1년 전 폐기된 결정이 계속 소환된다. 강화(접근 시 importance 상승)와
 * 망각(무접근 감쇠)을 산식으로 모사한다 — docs/06-engines.md §9.
 */

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * 중복 판정 임계값 — **임베더마다 다르다. 코드 상수로 못 박으면 안 된다.**
 *
 * 0.9 는 OpenAI 임베딩을 전제로 고른 값이었다. bge-m3(로컬)로 바꾸자 조용히 무너졌다.
 * 실측(스크립트: docs/14-offline-bigdata.md §중복제거):
 *
 *   병합되어야 하는 쌍(같은 사실, 다른 표현)   0.8959 ~ 0.9688
 *   보존되어야 하는 쌍(다른 사실, 같은 형태)   0.8468 ~ 0.9633
 *
 * **두 분포가 겹친다.** "배포는 화요일" vs "배포는 목요일"(0.9633)이
 * "배포는 화요일" vs "화요일이 배포일"(0.9520)보다 더 유사하다.
 * 즉 **어떤 단일 임계값으로도 둘을 가를 수 없다.** 0.9 에서는 서로 다른 사실 500개가
 * 39행으로 뭉개졌다 — 조용한 데이터 소실이다.
 *
 * 그래서 코사인만으로 파기하지 않는다:
 *   1단계 정규화 완전일치 — 임베더와 무관하게 항상 옳다.
 *   2단계 코사인 + 수치 일치 — 임계값을 보존 쪽 최댓값 위(0.97)로 올린다.
 * 덜 병합하는 쪽으로 기운다. 중복 한 줄은 잡음이지만, 지워진 기억은 복구되지 않는다.
 */
const DEFAULT_DEDUPE_THRESHOLD = 0.97;

/** 공백·유니코드 정규화 후 완전일치 비교용. 한글은 NFC/NFD가 섞여 들어온다. */
function normalizeForExactMatch(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 텍스트에 등장하는 수의 다중집합.
 * 사실이 값으로 구분되는 경우(버전, 날짜, 임계치, 개수)가 가장 흔한 소실 원인이다.
 * 수가 다르면 아무리 문장이 닮았어도 다른 사실로 본다.
 */
function numbersIn(s: string): string {
  return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(",");
}

export class LongTermMemory {
  private readonly dedupeThreshold: number;

  constructor(
    private pool: Pool,
    private embed: EmbedFn,
    /** 배포마다 임베더가 다르므로 설정으로 받는다. 라이브러리가 process.env를 읽지 않는다. */
    opts: { dedupeThreshold?: number } = {},
  ) {
    this.dedupeThreshold = opts.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
  }

  async remember(
    scope: MemoryScope,
    input: { kind: MemoryKind; content: string; importance?: number; sourceSessionId?: string },
  ): Promise<{ id: string; deduped: boolean }> {
    const [embedding] = await this.embed([input.content]);
    const vec = toVectorLiteral(embedding!);

    // 1) 같은 스코프에서 최근접 이웃 확인 → 중복이면 기존 항목 강화.
    //    완전일치 판정을 위해 content 도 같이 읽고 후보를 3개 본다.
    //    (완전일치는 sim=1.0 이라 1위지만, 동점이 있을 수 있다.)
    const { rows: near } = await this.pool.query<{ id: string; sim: number; content: string }>(
      `select id, content, 1 - (embedding <=> $1::vector) as sim
         from memory_items
        where org_id = $2
          and user_id is not distinct from $3
          and project_id is not distinct from $4
        order by embedding <=> $1::vector
        limit 3`,
      [vec, scope.orgId, scope.userId ?? null, scope.projectId ?? null],
    );

    const wanted = normalizeForExactMatch(input.content);
    const exact = near.find((r) => normalizeForExactMatch(r.content) === wanted);
    const candidate = near[0];
    // 수치가 다르면 문장이 아무리 닮아도 다른 사실이다 — 값 교체형 소실을 막는다.
    const fuzzy =
      !exact &&
      candidate &&
      candidate.sim >= this.dedupeThreshold &&
      numbersIn(candidate.content) === numbersIn(input.content)
        ? candidate
        : undefined;

    const top = exact ?? fuzzy;
    if (top) {
      await this.pool.query(
        `update memory_items
            set content = $2,
                embedding = $3::vector,
                importance = least(1.0, importance + 0.1),
                updated_at = now()
          where id = $1`,
        [top.id, input.content, vec],
      );
      return { id: top.id, deduped: true };
    }

    // 2) 신규 저장
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into memory_items (org_id, user_id, project_id, kind, content, embedding, importance, source_session_id)
       values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       returning id`,
      [
        scope.orgId,
        scope.userId ?? null,
        scope.projectId ?? null,
        input.kind,
        input.content,
        vec,
        input.importance ?? 0.5,
        input.sourceSessionId ?? null,
      ],
    );
    return { id: rows[0]!.id, deduped: false };
  }

  /**
   * 스코프 가시성 규칙: (org 공유) ∪ (내 개인 기억) ∪ (이 프로젝트 기억).
   * where 절이 곧 접근 제어다 — 서비스 레이어가 아니라 쿼리에서 강제한다.
   */
  async recall(scope: MemoryScope, query: string, k = 8): Promise<MemoryItem[]> {
    const [embedding] = await this.embed([query]);
    return this.recallByVector(scope, embedding!, k);
  }

  /**
   * 이미 계산된 질의 벡터로 소환한다.
   *
   * recall 을 쪼갠 이유: 지연시간의 대부분이 임베더에서 나오는데(실측 로컬 bge-m3 62ms vs
   * pgvector 2ms), 한 덩어리로 재면 성능 회귀가 '우리 코드가 느려졌다'인지
   * '임베더를 바꿨다'인지 구분되지 않는다. 벡터를 이미 가진 호출자(배치 소환, 성능 계측)도
   * 같은 질의를 반복해 임베딩할 필요가 없어진다.
   */
  async recallByVector(scope: MemoryScope, embedding: number[], k = 8): Promise<MemoryItem[]> {
    const vec = toVectorLiteral(embedding);

    const { rows } = await this.pool.query<{
      id: string;
      kind: MemoryKind;
      content: string;
      importance: number;
      score: number;
    }>(
      `select id, kind, content, importance,
              (0.60 * (1 - (embedding <=> $1::vector))
             + 0.25 * importance
             + 0.15 * exp(-extract(epoch from (now() - coalesce(last_accessed_at, created_at))) / (30.0 * 86400))
              ) as score
         from memory_items
        where org_id = $2
          and (user_id is null or user_id = $3)
          and (project_id is null or project_id = $4)
        order by embedding <=> $1::vector
        limit $5 * 4`,
      [vec, scope.orgId, scope.userId ?? null, scope.projectId ?? null, k],
    );

    // 벡터 인덱스가 상위 4k를 좁혀오고, 최종 순위는 복합 점수로 재정렬
    const top = rows.sort((a, b) => b.score - a.score).slice(0, k);

    if (top.length > 0) {
      // 강화: 소환된 기억은 접근 통계 갱신 (비동기 — 응답 경로 차단 금지)
      void this.pool
        .query(
          `update memory_items
              set access_count = access_count + 1, last_accessed_at = now()
            where id = any($1::uuid[])`,
          [top.map((r) => r.id)],
        )
        .catch(() => {});
    }
    return top;
  }

  async forget(id: string, orgId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from memory_items where id = $1 and org_id = $2`, [id, orgId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** 주간 잡: 90일 무접근 + 저중요도 기억 정리 (무한 축적은 recall 품질을 해친다) */
  async decay(): Promise<number> {
    const res = await this.pool.query(
      `delete from memory_items
        where importance < 0.3
          and coalesce(last_accessed_at, created_at) < now() - interval '90 days'`,
    );
    return res.rowCount ?? 0;
  }
}

/** pgvector 리터럴 포맷: '[0.1,0.2,...]' */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
