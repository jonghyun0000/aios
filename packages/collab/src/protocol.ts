/**
 * Yjs 동기화 프로토콜 — 서버가 이해해야 하는 최소 표면.
 *
 * 이전 구현은 WS로 온 바이너리를 해석 없이 릴레이만 했다. 그것으로는
 *  - 나중에 접속한 피어가 기존 문서 상태를 받지 못하고(빈 문서로 시작),
 *  - 서버 재시작 시 문서가 사라지며,
 *  - 누가 어디를 편집 중인지(awareness) 알 수 없다.
 * 즉 "실시간 협업"이라 부를 수 없다. 그래서 서버가 y-protocols의 sync 단계를
 * 실제로 수행하도록 바꾼다.
 *
 * 메시지 프레이밍은 y-websocket의 사실상 표준을 따른다:
 *   [varUint messageType, ...payload]
 * 이 규약을 그대로 쓰는 이유: 클라이언트가 y-websocket 계열 라이브러리를
 * 그대로 쓸 수 있어야 생태계 호환성이 생긴다. 자체 규약을 만들면 우리 클라이언트만 붙는다.
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export interface DocSession {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
}

/** 새 피어에게 보낼 sync step1 (내 상태 벡터를 알려 diff를 요청) */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

/** 현재 문서 전체 상태를 update로 보낸다 (신규 피어 부트스트랩) */
export function encodeSyncStep2(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(enc, doc);
  return encoding.toUint8Array(enc);
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(enc);
}

export interface HandleResult {
  /** 이 피어에게 즉시 돌려줄 응답 (sync step2 등). 없으면 null */
  reply: Uint8Array | null;
  /** 다른 피어에게 브로드캐스트할 메시지. 없으면 null */
  broadcast: Uint8Array | null;
}

/**
 * 수신 메시지 처리.
 *
 * 중요한 설계 결정: 서버는 문서를 '가지고' 있어야 한다.
 * 단순 릴레이면 서버가 상태를 모르므로 신규 피어에게 아무것도 줄 수 없다.
 * Y.Doc을 서버에 두면 sync step1 요청에 step2로 답할 수 있고,
 * 그 순간부터 늦게 들어온 피어도 기존 내용을 본다.
 */
export function handleMessage(
  session: DocSession,
  message: Uint8Array,
  origin: unknown,
): HandleResult {
  const dec = decoding.createDecoder(message);
  const type = decoding.readVarUint(dec);

  if (type === MESSAGE_SYNC) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    // readSyncMessage가 step1이면 step2를 써 넣고, update면 doc에 적용한다.
    syncProtocol.readSyncMessage(dec, enc, session.doc, origin);
    // 길이가 1이면 헤더만 있는 것 — 돌려줄 내용이 없다.
    const reply = encoding.length(enc) > 1 ? encoding.toUint8Array(enc) : null;
    return { reply, broadcast: null };
  }

  if (type === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(dec);
    awarenessProtocol.applyAwarenessUpdate(session.awareness, update, origin);
    // awareness는 원본 그대로 다른 피어에게 퍼뜨린다
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, update);
    return { reply: null, broadcast: encoding.toUint8Array(enc) };
  }

  // 모르는 타입은 조용히 버린다. 프로토콜이 확장돼도 서버가 죽지 않도록.
  return { reply: null, broadcast: null };
}
