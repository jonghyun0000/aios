import { describe, it, expect, vi } from "vitest";
import { LongTermMemory } from "../long-term.js";

/**
 * 중복제거 회귀 테스트.
 *
 * 왜 이게 필요한가: 임계값 0.9 시절, 서로 다른 사실 500개가 39행으로 병합돼
 * **조용히 사라졌다**. 행 수만 보면 "중복이 잘 제거됐다"로 보였다.
 * 임베더를 바꾸면(OpenAI→bge-m3) 유사도 분포가 통째로 옮겨가므로,
 * 임계값 하나에 안전을 걸어 두면 안 된다는 것이 그때의 교훈이다.
 *
 * 실제 임베더 없이 판정 로직만 고정한다 — 유사도는 주입한다.
 */

/** 최근접 이웃 1건을 돌려주는 가짜 풀. 판정 로직만 시험한다. */
function fakePool(neighbor: { content: string; sim: number } | null) {
  const inserted: string[] = [];
  const updated: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("order by embedding")) {
        return { rows: neighbor ? [{ id: "existing", content: neighbor.content, sim: neighbor.sim }] : [] };
      }
      if (sql.trimStart().startsWith("update")) {
        updated.push(String(params[1]));
        return { rows: [] };
      }
      inserted.push(String(params[4]));
      return { rows: [{ id: "new" }] };
    }),
  };
  return { pool: pool as never, inserted, updated };
}

const embed = async (texts: string[]) => texts.map(() => [0, 0, 1]);
const scope = { orgId: "org" } as never;
const write = async (
  neighbor: { content: string; sim: number } | null,
  content: string,
  opts?: { dedupeThreshold?: number },
) => {
  const f = fakePool(neighbor);
  const ltm = new LongTermMemory(f.pool, embed, opts);
  const res = await ltm.remember(scope, { kind: "fact", content });
  return { ...res, ...f };
};

describe("LongTermMemory 중복제거", () => {
  it("정규화 완전일치는 유사도와 무관하게 병합한다", async () => {
    // 유사도를 임계값 아래로 낮춰도 — 즉 임베더가 무엇이든 — 같은 문장은 같은 기억이다.
    const r = await write({ content: "사용자는 서울에 거주한다.", sim: 0.2 }, "  사용자는   서울에 거주한다.  ");
    expect(r.deduped).toBe(true);
  });

  it("자모 정규화(NFD)만 다른 한글도 같은 문장으로 본다", async () => {
    const nfd = "사용자는 서울에 거주한다.".normalize("NFD");
    const r = await write({ content: "사용자는 서울에 거주한다.".normalize("NFC"), sim: 0.2 }, nfd);
    expect(r.deduped).toBe(true);
  });

  it("실측 0.9633 — '화요일 vs 목요일'은 병합하지 않는다", async () => {
    // 이 쌍이 병합되던 것이 데이터 소실의 실제 형태였다.
    const r = await write({ content: "배포는 매주 화요일에 한다.", sim: 0.9633 }, "배포는 매주 목요일에 한다.");
    expect(r.deduped).toBe(false);
    expect(r.inserted).toEqual(["배포는 매주 목요일에 한다."]);
  });

  it("임계값을 넘어도 수치가 다르면 병합하지 않는다", async () => {
    // 값 교체형(버전·날짜·임계치)이 가장 흔한 소실 원인이라 별도 방어를 둔다.
    const r = await write({ content: "프로젝트 마감은 3월 15일이다.", sim: 0.999 }, "프로젝트 마감은 4월 15일이다.");
    expect(r.deduped).toBe(false);
  });

  it("임계값 위 + 수치 동일이면 병합한다", async () => {
    const r = await write({ content: "The user prefers dark mode.", sim: 0.975 }, "The user's preference is dark mode.");
    expect(r.deduped).toBe(true);
  });

  it("임계값은 설정으로 낮출 수 있다 — 배포마다 임베더가 다르다", async () => {
    const pair = { content: "The user prefers dark mode.", sim: 0.9688 } as const;
    expect((await write(pair, "The user's preference is dark mode.")).deduped).toBe(false);
    expect(
      (await write(pair, "The user's preference is dark mode.", { dedupeThreshold: 0.96 })).deduped,
    ).toBe(true);
  });

  it("이웃이 없으면 그냥 저장한다", async () => {
    const r = await write(null, "첫 기억이다.");
    expect(r.deduped).toBe(false);
  });
});
