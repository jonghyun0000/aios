import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, apiKeyStore, get, post, type Me } from "./api.js";

/**
 * 인증 상태.
 *
 * 부팅 시 `/v1/me`를 한 번 호출해 판단한다. 쿠키가 있으면 그것으로,
 * sessionStorage에 API 키가 있으면 그것으로 통과한다. 어느 쪽도 없으면 로그인 화면.
 *
 * "로딩 중"을 별도 상태로 두는 이유: 판단 전에 로그인 화면을 먼저 그리면
 * 새로고침할 때마다 로그인 폼이 번쩍인다.
 */

interface AuthState {
  status: "loading" | "authenticated" | "anonymous";
  me: Me | null;
  error: string | null;
  // 메서드 문법(`refresh(): ...`)이 아니라 함수 속성으로 선언한다.
  // 메서드로 선언하면 TypeScript가 "this를 쓸 수 있는 함수"로 보고,
  // `const { signOut } = useAuth()` 같은 구조분해가 unbound-method 경고를 낸다.
  // 실제로 이것들은 클로저라 this와 무관하므로 속성 문법이 더 정확하다.
  refresh: () => Promise<void>;
  signInWithApiKey: (key: string, remember?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await get<Me>("/v1/me");
      setMe(result);
      setStatus("authenticated");
      setError(null);
    } catch (err) {
      setMe(null);
      setStatus("anonymous");
      // 401은 "로그인 안 됨"이라는 정상 상태다 — 에러로 표시하면 첫 방문자에게 겁을 준다.
      if (err instanceof ApiError && err.isAuthError) setError(null);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signInWithApiKey = useCallback(
    async (key: string, remember = false) => {
      apiKeyStore.set(key.trim(), remember);
      try {
        const result = await get<Me>("/v1/me");
        setMe(result);
        setStatus("authenticated");
        setError(null);
      } catch (err) {
        // 실패한 키를 남겨두면 이후 모든 요청이 조용히 401이 된다.
        apiKeyStore.clear();
        throw err;
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    apiKeyStore.clear();
    // 쿠키 세션이면 서버에서도 폐기한다. API 키 로그인이었다면 세션이 없어 404가 나는데,
    // 그건 정상이므로 삼킨다.
    await post("/v1/auth/logout").catch(() => undefined);
    setMe(null);
    setStatus("anonymous");
  }, []);

  return (
    <AuthContext.Provider value={{ status, me, error, refresh, signInWithApiKey, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
