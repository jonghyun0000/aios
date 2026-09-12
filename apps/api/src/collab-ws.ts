import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PostgresDocPersistence, RoomManager, type Peer } from "@aios/collab";
import { ForbiddenError } from "@aios/shared";
import type { AppContext } from "./context.js";
import { authenticate, requireRole } from "./auth.js";

/**
 * 실시간 협업 WebSocket 엔드포인트.
 *
 * 이전 구현(`/v1/ws`의 collab.* JSON 메시지)은 base64 문자열을 해석 없이 릴레이했다.
 * 그 방식의 결함:
 *   1) 서버가 문서를 모르므로 늦게 접속한 사람이 기존 내용을 못 받는다.
 *   2) 재시작 시 문서 소실.
 *   3) base64로 30% 대역폭 낭비.
 * 그래서 바이너리 프레임 + 서버 측 Y.Doc으로 교체한다. 기존 `/v1/ws`는
 * 이벤트 구독 용도로 남긴다(둘의 트래픽 성격이 완전히 달라 한 소켓에 섞을 이유가 없다).
 *
 * 인가 모델: docId는 URL 쿼리로 오지만, 실제 격리는 org_id로 한다.
 * RoomManager를 org별로 하나씩 두어 다른 조직의 같은 이름 문서와 절대 섞이지 않게 한다.
 */

interface BinarySocketLike {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (raw: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1MB. 단일 편집 델타로는 과할 만큼 크다.

export async function registerCollabWs(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // org별 RoomManager. Redis 커넥션은 전체가 공유한다(sub 커넥션은 subscribe 전용).
  const managers = new Map<string, RoomManager>();
  const pub = ctx.redis;
  const sub = ctx.redis.duplicate();

  const managerFor = (orgId: string): RoomManager => {
    let m = managers.get(orgId);
    if (!m) {
      m = new RoomManager({
        persistence: new PostgresDocPersistence(ctx.pool, orgId),
        pub,
        sub,
      });
      managers.set(orgId, m);
    }
    return m;
  };

  app.get("/v1/collab", { websocket: true }, async (socket, req) => {
    const query = req.query as { token?: string; doc?: string };
    if (query.token) req.headers.authorization = `Bearer ${query.token}`;

    const ws = socket as unknown as BinarySocketLike;

    const docName = query.doc;
    if (!docName || docName.length > 200) {
      ws.close(4400, "doc query param required");
      return;
    }

    let orgId: string;
    let userId: string;
    try {
      const auth = await authenticate(ctx, req);
      // Yjs sync step2도 문서를 변경한다. 읽기 전용 프로토콜을 구현하기 전에는
      // viewer를 룸에 참가시키지 않는다(읽기 전용 협업을 지원한다는 뜻은 아니다).
      requireRole(auth, "member");
      orgId = auth.orgId;
      // API 키 인증에는 사람 주체가 없다. awareness 표시용이므로 대체 라벨을 쓴다.
      userId = auth.userId ?? `apikey:${orgId}`;
    } catch (err) {
      ws.close(err instanceof ForbiddenError ? 4403 : 4401, err instanceof ForbiddenError ? "member role required" : "unauthorized");
      return;
    }

    // Redis 채널 키에 orgId를 넣어 조직 간 문서 충돌을 원천 차단한다.
    const docId = `${orgId}:${docName}`;
    const manager = managerFor(orgId);

    const peer: Peer = {
      id: randomUUID(),
      userId,
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };

    let room;
    try {
      room = await manager.join(docId, peer);
    } catch (err) {
      req.log.error({ err, docId }, "collab join failed");
      ws.close(1011, "join failed");
      return;
    }

    req.log.info({ docId, peers: room.peerCount, userId }, "collab peer joined");

    ws.on("message", (raw: Buffer) => {
      if (raw.byteLength > MAX_MESSAGE_BYTES) {
        ws.close(1009, "message too large");
        return;
      }
      try {
        room.handle(peer, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      } catch (err) {
        // 잘못된 프레임 하나로 룸 전체가 죽으면 안 된다. 이 피어만 끊는다.
        req.log.warn({ err, docId }, "collab message rejected");
        ws.close(1007, "invalid frame");
      }
    });

    ws.on("error", (err) => req.log.warn({ err, docId }, "collab socket error"));

    ws.on("close", () => {
      void manager.leave(docId, peer).catch((err) => {
        req.log.error({ err, docId }, "collab leave failed");
      });
    });
  });

  // 셧다운 시 모든 문서를 저장한다. 이게 없으면 배포마다 최대 2초(디바운스)의 편집이 날아간다.
  app.addHook("onClose", async () => {
    const results = await Promise.allSettled([...managers.values()].map((m) => m.close()));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    await sub.quit().catch((err: unknown) => { errors.push(err); });
    // 종료 코드 0을 백업의 쓰기 중단 근거로 쓰므로 저장 실패를 삼키지 않는다.
    if (errors.length) throw new AggregateError(errors, "협업 상태를 안전하게 저장하지 못했습니다.");
    managers.clear();
  });
}
