/**
 * 대화별 입력 초안(docs/44). 서버로 보내지 않고 이 브라우저에만 둔다.
 *
 * localStorage 를 쓰는 이유: 새로고침·브라우저 재시작 뒤에도 쓰던 글이 돌아와야 한다(sessionStorage 는 탭을 닫으면 사라진다).
 * 대신 한도(20개·50,000자·7일)를 두고 로그아웃 때 모두 지운다. 저장소가 막히거나 기록이 깨져도 채팅은 계속 동작해야
 * 하므로 모든 접근을 try/catch 로 감싸고 실패는 "보관 안 됨"으로만 알린다.
 */
const KEY = "aios.chat-drafts.v1";
export const DRAFT_LIMITS = { entries: 20, chars: 50_000, ttlMs: 7 * 24 * 60 * 60 * 1000 } as const;
/** 대화를 고르기 전(새 대화)의 초안 키 */
export const NEW_CHAT = "new";
type Entry = { text: string; at: number };
export type DraftSave = "saved" | "cleared" | "too_long" | "unavailable";

function storage(): Storage | null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }
function read(now: number): Record<string, Entry> {
  const s = storage(); if (!s) return {};
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, Entry> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<Entry> | null;
      if (key.length > 100 || !entry || typeof entry.text !== "string" || !entry.text || entry.text.length > DRAFT_LIMITS.chars
        || typeof entry.at !== "number" || !Number.isFinite(entry.at) || now - entry.at > DRAFT_LIMITS.ttlMs) continue;
      out[key] = { text: entry.text, at: entry.at };
    }
    return out;
  } catch { return {}; }
}
function write(entries: Record<string, Entry>): boolean {
  const s = storage(); if (!s) return false;
  try {
    const keep = Object.entries(entries).sort((a, b) => b[1].at - a[1].at).slice(0, DRAFT_LIMITS.entries);
    if (keep.length) s.setItem(KEY, JSON.stringify(Object.fromEntries(keep))); else s.removeItem(KEY);
    return true;
  } catch { return false; }
}

export function loadDraft(key: string, now = Date.now()): string { return read(now)[key]?.text ?? ""; }

export function saveDraft(key: string, text: string, now = Date.now()): DraftSave {
  const entries = read(now);
  if (!text.trim()) { delete entries[key]; return write(entries) ? "cleared" : "unavailable"; }
  if (text.length > DRAFT_LIMITS.chars) { delete entries[key]; write(entries); return "too_long"; }
  entries[key] = { text, at: now };
  return write(entries) ? "saved" : "unavailable";
}

export function clearAllDrafts(): void { try { storage()?.removeItem(KEY); } catch { /* 저장소가 막혀 있으면 지울 것도 없다 */ } }
