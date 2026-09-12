import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

/**
 * 브라우저용 Yjs WebSocket 프로바이더.
 *
 * y-websocket 패키지를 쓰지 않는 이유: 우리 서버가 이미 그 프레이밍을 구현하고 있고,
 * 클라이언트 쪽에서 필요한 것은 (1) 프레임 인코딩/디코딩, (2) 재연결뿐이다.
 * 패키지를 들이면 우리가 제어하지 않는 재연결·인증 정책이 따라온다.
 *
 * 재연결은 지수 백오프 + 지터를 쓴다. 고정 간격이면 서버 재시작 시 모든 클라이언트가
 * 같은 순간에 몰려 재부팅 직후를 다시 무너뜨린다(thundering herd).
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CollabPeer {
  clientId: number;
  name: string;
  color: string;
}

export interface CollabProviderOptions {
  onStatus?(status: ConnectionStatus): void;
  onPeers?(peers: CollabPeer[]): void;
  /** 이 사용자를 다른 참여자에게 어떻게 보여줄지 */
  identity: { name: string; color: string };
}

export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private status: ConnectionStatus = "connecting";

  constructor(
    private url: string,
    private opts: CollabProviderOptions,
  ) {
    this.awareness.setLocalStateField("user", opts.identity);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // 서버에서 받은 것을 되돌려보내지 않는다
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    this.awareness.on("update", (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== "local") {
        // 원격 변경은 그대로 화면에만 반영한다
        this.emitPeers();
        return;
      }
      const ids = [...changes.added, ...changes.updated, ...changes.removed];
      if (ids.length === 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
      this.send(encoding.toUint8Array(enc));
      this.emitPeers();
    });

    this.connect();
  }

  get text(): Y.Text {
    return this.doc.getText("body");
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private emitPeers(): void {
    const peers: CollabPeer[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const user = (state as { user?: CollabPeer })?.user;
      if (user) peers.push({ clientId, name: user.name, color: user.color });
    }
    this.opts.onPeers?.(peers);
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("connected");
      // 재연결 시 서버는 우리 상태를 모른다. 우리 쪽 상태 벡터를 보내 diff를 받는다.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc));
      // 내 커서를 다시 알린다 — 끊긴 동안 서버가 지웠을 수 있다.
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      );
      ws.send(encoding.toUint8Array(aenc));
    };

    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const data = new Uint8Array(ev.data);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MESSAGE_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
        this.emitPeers();
      }
    };

    ws.onclose = (ev) => {
      this.ws = null;
      this.setStatus("disconnected");
      // 4401(인증 실패)/4400(잘못된 요청)은 재시도해도 결과가 같다. 무한 루프를 만들지 않는다.
      if (this.closed || ev.code === 4401 || ev.code === 4400) return;
      const delay = Math.min(1000 * 2 ** this.attempt, 15_000);
      const jitter = Math.random() * 400;
      this.attempt++;
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay + jitter);
    };

    ws.onerror = () => {
      // onclose가 뒤따르므로 여기서는 아무것도 하지 않는다.
    };
  }

  private send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  setCursor(index: number | null): void {
    this.awareness.setLocalStateField("cursor", index === null ? null : { index });
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    // 나가면서 커서를 지운다 — 서버도 정리하지만 즉시 반영이 낫다.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.ws?.close(1000, "component unmounted");
    this.awareness.destroy();
    this.doc.destroy();
  }
}
