import { createHash } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";

const mocks = vi.hoisted(() => ({ join: vi.fn(), handle: vi.fn(), close: vi.fn(), leave: vi.fn() }));
vi.mock("@aios/collab", () => ({
  PostgresDocPersistence: vi.fn(),
  RoomManager: vi.fn(() => ({ join: mocks.join, close: mocks.close, leave: mocks.leave })),
}));
import { registerCollabWs } from "../collab-ws.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.join.mockResolvedValue({ peerCount: 1, handle: mocks.handle });
  mocks.close.mockResolvedValue(undefined);
  mocks.leave.mockResolvedValue(undefined);
});

async function fixture(role: "viewer" | "member", via: "api_key" | "session") {
  // Synthetic credentials live only in this fixture; no environment or real database is read.
  const token = via === "session" ? "aios_sess_invalid_permission_fixture" : "aios_invalid_permission_fixture";
  const hash = createHash("sha256").update(token).digest("hex");
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes("from api_keys") && values[0] === hash) return { rows: [{ id: "key", org_id: "org", role, scopes: ["*"], expires_at: null }] };
    if (sql.includes("from auth_sessions") && values[0] === hash) return { rows: [{ user_id: "user", token_hash: hash }] };
    if (sql.includes("from org_members")) return { rows: [{ org_id: "org", role }] };
    if (sql.startsWith("update api_keys set last_used_at")) return { rows: [] };
    throw new Error("unexpected fixture query");
  });
  const ctx = { env: { LOCAL_NO_AUTH: false }, pool: { query }, redis: { duplicate: () => ({ quit: vi.fn(async () => "OK") }) } } as unknown as AppContext;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(websocket);
  await registerCollabWs(app, ctx);
  await app.ready();
  const connect = () => app.injectWS("/v1/collab?doc=permissions-fixture", {
    headers: via === "session" ? { cookie: `aios_session=${token}` } : { authorization: `Bearer ${token}` },
  });
  return { app, connect };
}

describe("협업 쓰기 권한 — 실제 인증·WebSocket, DB/룸 대역", () => {
  it.each(["api_key", "session"] as const)("%s viewer는 문서에 참가하기 전에 4403으로 거부한다", async (via) => {
    const f = await fixture("viewer", via);
    const ws = await f.connect();
    const closed = vi.fn();
    ws.on("close", closed);
    try {
      await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 500 });
      expect(closed.mock.calls[0]![0]).toBe(4403);
      expect(mocks.join).not.toHaveBeenCalled();
      expect(mocks.handle).not.toHaveBeenCalled();
    } finally { ws.terminate(); await f.app.close(); }
  });

  it.each(["api_key", "session"] as const)("%s member는 접속 후 바이너리 편집 프레임을 처리한다", async (via) => {
    const f = await fixture("member", via);
    const ws = await f.connect();
    try {
      await vi.waitFor(() => expect(mocks.join).toHaveBeenCalledOnce());
      ws.send(Buffer.from([0, 2, 0]));
      await vi.waitFor(() => expect(mocks.handle).toHaveBeenCalledOnce());
      expect(mocks.join.mock.calls[0]![0]).toBe("org:permissions-fixture");
    } finally { ws.terminate(); await f.app.close(); }
  });

  it("인증 없는 요청은 권한 오류와 구분하여 4401로 거부한다", async () => {
    const f = await fixture("member", "api_key");
    const ws = await f.app.injectWS("/v1/collab?doc=permissions-fixture");
    const closed = vi.fn();
    ws.on("close", closed);
    try {
      await vi.waitFor(() => expect(closed).toHaveBeenCalled());
      expect(closed.mock.calls[0]![0]).toBe(4401);
      expect(mocks.join).not.toHaveBeenCalled();
    } finally { ws.terminate(); await f.app.close(); }
  });
});
