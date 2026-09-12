import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@aios/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth.js", async (original) => ({ ...await original<typeof import("../auth.js")>(), authenticate: mocks.authenticate }));
import { registerWs } from "../ws.js";

beforeEach(() => { vi.clearAllMocks(); });

async function fixture(role: AuthContext["role"] = "viewer") {
  mocks.authenticate.mockResolvedValue({ orgId: "synthetic-org", role, via: "api_key", scopes: ["*"] });
  let connect!: (socket: unknown, req: unknown) => Promise<void>;
  let incoming!: (pattern: string, channel: string, payload: string) => void;
  let receive!: (raw: Buffer) => void;
  let disconnect!: () => void;
  const publish = vi.fn(async () => 1);
  const socket = {
    OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(),
    on(event: string, callback: (raw: Buffer) => void) {
      if (event === "message") receive = callback;
      if (event === "close") disconnect = callback as () => void;
    },
  };
  const app = { get: (_url: string, _options: unknown, handler: typeof connect) => { connect = handler; } } as unknown as FastifyInstance;
  const ctx = {
    redis: { publish, duplicate: () => ({ psubscribe: vi.fn(async () => 1), on: (_event: string, callback: typeof incoming) => { incoming = callback; } }) },
    bus: { subscribe: vi.fn(async () => {}) },
  } as unknown as AppContext;
  await registerWs(app, ctx);
  await connect(socket, { query: {}, headers: {} });
  return { publish, socket, message: (value: unknown) => receive(Buffer.from(JSON.stringify(value))), incoming: (channel: string, payload = "SYNTHETIC_EVENT") => incoming("ch:*", `ch:${channel}`, payload), disconnect: () => disconnect() };
}

describe("구형 WebSocket도 viewer의 읽기/쓰기와 조직 경계를 구분한다 (인증/Redis 대역)", () => {
  it("viewer는 자기 조직 이벤트를 읽지만 다른 조직 구독 문자열로 탈출하지 않는다", async () => {
    const f = await fixture();
    f.message({ t: "sub", ch: "events" });
    f.message({ t: "sub", ch: "other-org:events" });
    f.incoming("other-org:events", "OTHER_ORG_SYNTHETIC");
    expect(f.socket.send).not.toHaveBeenCalled();
    f.incoming("synthetic-org:events");
    expect(f.socket.send).toHaveBeenCalledWith("SYNTHETIC_EVENT");
    expect(f.socket.close).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    f.disconnect();
  });

  it("viewer의 collab.update는 Redis 발행 전 거부되고 이벤트 읽기는 유지된다", async () => {
    const f = await fixture();
    f.message({ t: "collab.update", doc: "fixture-doc", u: "SYNTHETIC_UPDATE" });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ t: "error", code: "forbidden", message: "member role required" }));
    expect(f.socket.close).not.toHaveBeenCalled();
    f.socket.send.mockClear();
    f.message({ t: "sub", ch: "events" }); f.incoming("synthetic-org:events");
    expect(f.socket.send).toHaveBeenCalledWith("SYNTHETIC_EVENT");
    f.disconnect();
  });

  it.each(["member", "admin", "owner"] as const)("%s는 구형 협업 변경을 자기 조직 채널에만 발행한다", async (role) => {
    const f = await fixture(role);
    f.message({ t: "collab.update", doc: "other-org:fixture-doc", u: "SYNTHETIC_UPDATE" });
    expect(f.publish).toHaveBeenCalledWith("ch:synthetic-org:collab:other-org:fixture-doc", JSON.stringify({ t: "collab.update", doc: "other-org:fixture-doc", u: "SYNTHETIC_UPDATE" }));
    expect(f.socket.close).not.toHaveBeenCalled(); f.disconnect();
  });

  it("viewer의 구형 협업 구독도 읽기만 유지하고 연결 종료 후 수신하지 않는다", async () => {
    const f = await fixture();
    f.message({ t: "collab.join", doc: "fixture-doc" });
    f.incoming("other-org:collab:fixture-doc"); expect(f.socket.send).not.toHaveBeenCalled();
    f.incoming("synthetic-org:collab:fixture-doc"); expect(f.socket.send).toHaveBeenCalledWith("SYNTHETIC_EVENT");
    f.disconnect(); f.socket.send.mockClear(); f.incoming("synthetic-org:collab:fixture-doc");
    expect(f.socket.send).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });

  it("파싱 가능한 잘못된 JSON/null은 메시지 핸들러를 예외 종료하지 않는다", async () => {
    const f = await fixture("member");
    for (const value of [null, [], "text", 42, { t: "collab.update", doc: {}, u: "bad" }, { t: "collab.update", doc: "doc", u: {} }]) expect(() => f.message(value)).not.toThrow();
    expect(f.publish).not.toHaveBeenCalled(); f.disconnect();
  });
});
