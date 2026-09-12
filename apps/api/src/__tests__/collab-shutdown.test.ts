import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), close: vi.fn(), quit: vi.fn() }));
vi.mock("../auth.js", () => ({ authenticate: mocks.authenticate }));
vi.mock("@aios/collab", () => ({
  PostgresDocPersistence: vi.fn(),
  RoomManager: vi.fn(() => ({
    join: vi.fn(async () => ({ peerCount: 1, handle() {} })),
    leave: vi.fn(async () => {}),
    close: mocks.close,
  })),
}));
import { registerCollabWs } from "../collab-ws.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ orgId: "org", userId: "user" });
  mocks.close.mockResolvedValue(undefined);
  mocks.quit.mockResolvedValue("OK");
});

async function setup() {
  let connect!: (socket: unknown, req: unknown) => Promise<void>;
  let close!: () => Promise<void>;
  const app = {
    get: (_url: string, _opts: unknown, handler: typeof connect) => { connect = handler; },
    addHook: (_name: string, hook: typeof close) => { close = hook; },
  } as unknown as FastifyInstance;
  const ctx = { pool: {}, redis: { duplicate: () => ({ quit: mocks.quit }) } } as unknown as AppContext;
  await registerCollabWs(app, ctx);
  await connect({ OPEN: 1, readyState: 1, send() {}, close() {}, on() {} }, {
    query: { doc: "shutdown-fixture" }, headers: {},
    log: { info() {}, warn() {}, error() {} },
  });
  return close;
}

describe("협업 API 종료 오류 전파", () => {
  it("문서 flush 장애가 실제 onClose에서 실패하며 Redis 정리도 시도한다", async () => {
    const close = await setup();
    mocks.close.mockRejectedValueOnce(new Error("injected document save failure"));
    await expect(close()).rejects.toThrow("협업 상태를 안전하게 저장하지 못했습니다");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it("문서 저장이 성공하면 정상 종료한다", async () => {
    const close = await setup();
    await expect(close()).resolves.toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
