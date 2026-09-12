import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@aios/shared";
import type { AppContext } from "./context.js";
import { authenticate, requireRole } from "./auth.js";

/**
 * WebSocket — 이벤트 구독 + 실시간 협업(Yjs relay).
 *
 * 설계 원칙: 서버는 Yjs 업데이트를 해석하지 않는 '멍청한 릴레이'.
 * 노드 간 팬아웃은 Redis PubSub — WS 노드는 stateless 라서 수평 확장이 자유롭다.
 * (Streams가 아닌 PubSub인 이유: 협업 델타는 저지연·유실허용. 늦게 온 피어는
 * 어차피 다른 피어와의 Yjs 상태 동기화로 따라잡는다.)
 */

/** ws.WebSocket의 구조적 서브셋 — @types/ws 의존 없이 필요한 표면만 계약 */
interface SocketLike {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
}

interface WsClient {
  socket: SocketLike;
  orgId: string;
  channels: Set<string>;
}

export async function registerWs(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const clients = new Set<WsClient>();

  // Redis 구독 커넥션 (publish용 커넥션과 분리 — subscribe 모드 커넥션은 다른 명령 불가)
  const sub = ctx.redis.duplicate();
  await sub.psubscribe("ch:*");
  sub.on("pmessage", (_pattern, channel, message) => {
    const ch = channel.slice(3);
    for (const c of clients) {
      if (c.channels.has(ch) && c.socket.readyState === c.socket.OPEN) {
        c.socket.send(message);
      }
    }
  });

  const publish = (orgId: string, ch: string, payload: unknown) =>
    ctx.redis.publish(`ch:${orgId}:${ch}`, JSON.stringify(payload));

  app.get("/v1/ws", { websocket: true }, async (socket, req) => {
    // WS는 커스텀 헤더가 불가한 클라이언트가 많아 query token 허용
    const token = (req.query as { token?: string }).token;
    if (token) req.headers.authorization = `Bearer ${token}`;
    let auth: AuthContext;
    try {
      auth = await authenticate(ctx, req);
    } catch {
      socket.close(4401, "unauthorized");
      return;
    }
    const { orgId } = auth;

    const client: WsClient = { socket, orgId, channels: new Set() };
    clients.add(client);

    socket.on("message", (raw: Buffer) => {
      let msg: { t: string; ch?: string; doc?: string; u?: string };
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        // JSON 파싱 성공은 프레임 형식 검증이 아니다. null/배열/객체 필드로 콜백이 죽거나
        // 채널 이름이 암묵적으로 변환되지 않도록 필요한 문자열만 허용한다.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("t" in parsed) || typeof parsed.t !== "string") return;
        if (["ch", "doc", "u"].some((key) => key in parsed && typeof (parsed as Record<string, unknown>)[key] !== "string")) return;
        msg = parsed as typeof msg;
      } catch {
        return;
      }
      switch (msg.t) {
        case "ping":
          socket.send(JSON.stringify({ t: "pong" }));
          break;
        case "sub":
          // 채널 네임스페이스에 orgId를 강제 — 다른 조직 채널 구독은 문법적으로 불가능
          if (msg.ch) client.channels.add(`${orgId}:${msg.ch}`);
          break;
        case "unsub":
          if (msg.ch) client.channels.delete(`${orgId}:${msg.ch}`);
          break;
        case "collab.join":
          if (msg.doc) client.channels.add(`${orgId}:collab:${msg.doc}`);
          break;
        case "collab.update":
          if (msg.doc && msg.u) {
            // 연결/구독은 viewer에게 필요한 읽기 기능이다. 구형 릴레이도 쓰기 프레임만
            // member 이상으로 제한하고, 거부하더라도 기존 이벤트 구독은 유지한다.
            try { requireRole(auth, "member"); }
            catch {
              socket.send(JSON.stringify({ t: "error", code: "forbidden", message: "member role required" }));
              break;
            }
            void publish(orgId, `collab:${msg.doc}`, { t: "collab.update", doc: msg.doc, u: msg.u });
          }
          break;
      }
    });

    socket.on("close", () => clients.delete(client));
  });

  // EventBus → WS 브리지: 워커가 발행한 도메인 이벤트(인덱싱 진행률 등)를 조직 채널로 중계
  void ctx.bus.subscribe("ws-bridge", `ws-${process.pid}`, async (e) => {
    if (e.orgId) await publish(e.orgId, `events`, { t: "event", ev: e });
  });
}
