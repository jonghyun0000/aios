import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { get, type SessionRow } from "./api.js";
import { useRouter } from "./router.js";

interface SessionPage { sessions: SessionRow[]; nextCursor: string | null }

function useSessionState() {
  const { navigate } = useRouter();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const [search, setSearch] = useState("");
  const [trash, setTrash] = useState(false);
  const request = useRef(0);
  const fetching = useRef(false);

  const load = useCallback(async (after?: string) => {
    const version = ++request.current;
    fetching.current = true;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (trash) params.set("trash", "true");
      if (after) params.set("cursor", after);
      const page = await get<SessionPage>(`/v1/sessions${params.size ? `?${params}` : ""}`);
      if (request.current !== version) return;
      setRows((old) => after ? [...new Map([...old, ...page.sessions].map((s) => [s.id, s])).values()] : page.sessions);
      setCursor(page.nextCursor);
    } catch (err) {
      if (request.current === version) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request.current === version) { fetching.current = false; setLoading(false); }
    }
  }, [search, trash]);

  const refresh = useCallback(() => { void load(); }, [load]);
  const loadMore = useCallback(() => {
    if (cursor && !fetching.current) void load(cursor);
  }, [cursor, load]);
  const newChat = useCallback(() => {
    if (busy) return;
    setDraftKey((key) => key + 1);
    setTrash(false); setSearch("");
    navigate("/chat");
  }, [busy, navigate]);

  useEffect(() => {
    const counter = request;
    setRows([]); setCursor(null); setLoading(true);
    const timer = window.setTimeout(refresh, 200);
    return () => { counter.current++; window.clearTimeout(timer); };
  }, [refresh]);

  return { rows, loading, error, hasMore: !!cursor, loadMore, refresh, busy, setBusy, newChat, draftKey, search, setSearch, trash, setTrash };
}

const SessionContext = createContext<ReturnType<typeof useSessionState> | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const value = useSessionState();
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSessions() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSessions needs SessionProvider");
  return value;
}
