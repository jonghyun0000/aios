import { describe, it, expect, vi } from "vitest";
import { LocalAdapter } from "../providers/local.js";

/**
 * 임베딩 동시성 상한 회귀 테스트.
 *
 * 실측 근거: 로컬 bge-m3 는 동시성 4에서 처리량이 포화하고, 25로 올리면 p95 지연만 5~7배가 된다.
 * 상한이 조용히 사라지면 추론 서버 큐가 무한정 깊어지는데 기능 테스트로는 드러나지 않는다.
 * 여기서는 '동시에 몇 개가 서버에 도달하는가'만 본다 — 속도가 아니라 계약을 고정한다.
 */

/** OpenAiAdapter.prototype — LocalAdapter 가 super.embed 로 부르는 실제 대상. */
type EmbedProto = { embed: (texts: string[], model?: string) => Promise<number[][]> };
const superProto = (a: LocalAdapter): EmbedProto =>
  Object.getPrototypeOf(Object.getPrototypeOf(a)) as EmbedProto;

/** super.embed 를 가로채, 동시에 몇 건이 진행 중인지 기록하는 어댑터. */
function probe(limit?: number) {
  const a = new LocalAdapter("http://local.test/v1", "bge-m3", "k", limit);
  const state = { now: 0, peak: 0, order: [] as number[] };
  const release: (() => void)[] = [];
  // 상위 클래스의 실제 HTTP 호출을 막고, 우리가 원할 때 끝나게 만든다.
  vi.spyOn(superProto(a), "embed")
    .mockImplementation(async (texts: string[]) => {
      state.now++;
      state.peak = Math.max(state.peak, state.now);
      state.order.push(Number(texts[0]));
      await new Promise<void>((res) => release.push(() => { state.now--; res(); }));
      return [[0]];
    });
  return { a, state, drain: () => { while (release.length) release.shift()!(); } };
}

describe("LocalAdapter 임베딩 동시성", () => {
  it("기본 상한 4를 넘겨 서버에 도달하지 않는다", async () => {
    const { a, state, drain } = probe();
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => a.embed([String(i)])));
    await vi.waitFor(() => expect(state.now).toBe(4));
    expect(state.peak).toBe(4);
    // 슬롯이 나면 다음 요청이 들어간다 — 막히는 게 아니라 줄 서는 것이다.
    const t = setInterval(drain, 0);
    await all;
    clearInterval(t);
    expect(state.peak).toBe(4);
    expect(state.order).toHaveLength(20);
  });

  it("상한은 설정으로 바꿀 수 있다 — 서버 성능은 배포마다 다르다", async () => {
    const { a, state, drain } = probe(2);
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => a.embed([String(i)])));
    await vi.waitFor(() => expect(state.now).toBe(2));
    const t = setInterval(drain, 0);
    await all;
    clearInterval(t);
    expect(state.peak).toBe(2);
  });

  it("대기열은 FIFO다 — LIFO면 먼저 온 요청의 꼬리 지연이 폭발한다", async () => {
    const { a, state, drain } = probe(1);
    const all = Promise.all(Array.from({ length: 5 }, (_, i) => a.embed([String(i)])));
    const t = setInterval(drain, 0);
    await all;
    clearInterval(t);
    expect(state.order).toEqual([0, 1, 2, 3, 4]);
  });

  it("요청이 실패해도 슬롯을 돌려준다 — 한 번의 오류로 영구히 막히면 안 된다", async () => {
    const a = new LocalAdapter("http://local.test/v1", "bge-m3", "k", 1);
    let calls = 0;
    vi.spyOn(superProto(a), "embed")
      .mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error("서버 오류");
        return [[1]];
      });
    await expect(a.embed(["첫 번째"])).rejects.toThrow("서버 오류");
    // 슬롯이 새지 않았다면 두 번째 호출이 그대로 진행된다.
    await expect(a.embed(["두 번째"])).resolves.toEqual([[1]]);
    expect(calls).toBe(2);
  });
});

/**
 * 생성(chat) 동시성 게이트.
 *
 * 실측 근거: 동시성 6으로 12개 스트림을 던지자 2개가
 * `UND_ERR_HEADERS_TIMEOUT` 으로 죽었다 — 서버 큐에서 300초를 넘게 기다렸기 때문이다.
 * 상한이 조용히 사라지면 같은 장애가 재발하는데, 기능 테스트로는 드러나지 않는다.
 */
describe("LocalAdapter 생성 동시성", () => {
  it("슬롯을 기다리는 취소 요청은 즉시 빠지고 다음 요청의 슬롯을 소모하지 않는다", async () => {
    const adapter = new LocalAdapter("http://local.test/v1", "bge-m3", "k", 1, 1);
    vi.spyOn(superStream(adapter), "stream").mockImplementation(async function* () {
      yield { type: "text_delta", text: "ok" };
    });
    const first = adapter.stream({ model: "m", messages: [] });
    await first.next();
    const ac = new AbortController();
    const second = adapter.stream({ model: "m", messages: [], abortSignal: ac.signal });
    const check = expect(second.next()).rejects.toThrow();
    ac.abort();
    await check;
    await first.return(undefined);
    const third = adapter.stream({ model: "m", messages: [] });
    expect((await third.next()).value).toMatchObject({ type: "timing", phase: "client_queue" });
    expect((await third.next()).value).toMatchObject({ text: "ok" });
    await third.return(undefined);
  });
  type StreamProto = { stream: (req: unknown) => AsyncGenerator<unknown> };
  const superStream = (a: LocalAdapter): StreamProto =>
    Object.getPrototypeOf(Object.getPrototypeOf(a)) as StreamProto;

  /** super.stream 을 가로채, 우리가 놓아줄 때까지 열려 있는 스트림으로 만든다. */
  function probeStream(limit?: number) {
    const a = new LocalAdapter("http://local.test/v1", "bge-m3", "k", undefined, limit);
    const state = { now: 0, peak: 0 };
    const release: (() => void)[] = [];
    vi.spyOn(superStream(a), "stream").mockImplementation(async function* () {
      state.now++;
      state.peak = Math.max(state.peak, state.now);
      await new Promise<void>((res) => release.push(() => { state.now--; res(); }));
      yield { type: "done", stopReason: "end_turn" };
    });
    return { a, state, drain: () => { while (release.length) release.shift()!(); } };
  }

  const drainStream = async (g: AsyncGenerator<unknown>) => { for await (const _ of g) { /* 소비 */ } };

  it("기본 상한 2를 넘겨 서버에 도달하지 않는다", async () => {
    const { a, state, drain } = probeStream();
    const all = Promise.all(Array.from({ length: 8 }, () => drainStream(a.stream({} as never))));
    await vi.waitFor(() => expect(state.now).toBe(2));
    const t = setInterval(drain, 0);
    await all;
    clearInterval(t);
    expect(state.peak).toBe(2);
  });

  it("소비자가 도중에 멈춰도 슬롯을 반납한다", async () => {
    // 이게 새면 취소 몇 번에 게이트가 영구히 막힌다 — 사용자에게는 '앱이 멈췄다'로 보인다.
    const { a, state, drain } = probeStream(1);
    const g = a.stream({} as never);
    expect((await g.next()).value).toMatchObject({ type: "timing", phase: "client_queue" });
    const first = g.next();
    await vi.waitFor(() => expect(state.now).toBe(1));
    drain();
    await first;
    await g.return(undefined); // 도중 중단
    // 슬롯이 돌아왔다면 다음 스트림이 그대로 진행된다.
    const g2 = a.stream({} as never);
    await g2.next(); // 대기열 측정 메타데이터
    const p2 = g2.next();
    await vi.waitFor(() => expect(state.now).toBe(1));
    drain();
    await p2;
    await g2.return(undefined);
    expect(state.peak).toBe(1);
  });

  it("임베딩과 생성 게이트는 서로를 굶기지 않는다", async () => {
    // 하나의 카운터를 공유하면 임베딩 폭주가 채팅을 막는다. 게이트를 분리한 이유다.
    const a = new LocalAdapter("http://local.test/v1", "bge-m3", "k", 1, 1);
    let embedRunning = 0;
    vi.spyOn(superProto(a), "embed")
      .mockImplementation(async () => { embedRunning++; await new Promise((r) => setTimeout(r, 30)); return [[0]]; });
    let chatDone = false;
    vi.spyOn(superStream(a), "stream").mockImplementation(async function* () {
      chatDone = true; yield { type: "done", stopReason: "end_turn" };
    });
    const embeds = Promise.all([a.embed(["a"]), a.embed(["b"]), a.embed(["c"])]);
    await drainStream(a.stream({} as never)); // 임베딩이 줄 서 있어도 채팅은 통과해야 한다
    expect(chatDone).toBe(true);
    await embeds;
    expect(embedRunning).toBe(3);
  });
});
