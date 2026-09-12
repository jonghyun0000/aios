import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type CSSProperties, type ReactNode,
} from "react";

/**
 * 최소 해시 라우터.
 *
 * react-router를 쓰지 않는 이유: 이 앱의 라우팅 요구는 "경로 문자열 → 화면"과
 * 파라미터 하나가 전부다. 라이브러리가 주는 중첩 라우트·로더·데이터 API는 쓰지 않는데
 * 번들과 개념 부담만 남는다. 이 저장소는 같은 이유로 AI 프로바이더 SDK도 쓰지 않는다.
 *
 * 해시 라우팅을 쓰는 이유: 정적 파일 서버가 어떤 SPA fallback도 갖추지 않아도 동작한다.
 * (우리 서버는 fallback이 있지만, 이 번들을 CDN이나 file://에 올려도 깨지지 않는다.)
 */

interface RouteState {
  path: string;
  params: Record<string, string>;
  /** 메서드가 아니라 함수 속성 — 구조분해해서 쓰는 클로저다(auth.tsx의 같은 주석 참조). */
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouteState | null>(null);

function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  return raw === "" ? "/" : raw;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    if (currentPath() === to) return;
    window.location.hash = to;
  }, []);

  const value = useMemo<RouteState>(() => ({ path, params: {}, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouteState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}

/**
 * `/collab/:doc` 형태의 패턴을 현재 경로에 맞춰본다.
 * 맞으면 파라미터 객체를, 아니면 null을 반환한다.
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const actual = a[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(actual);
    else if (seg !== actual) return null;
  }
  return params;
}

export function Link({
  to, children, className, style, title, ariaCurrent,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** 현재 페이지를 가리키는 링크에 "page" 를 준다. 색만으로는 스크린리더가 알 수 없다. */
  ariaCurrent?: "page";
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={`#${to}`}
      className={className}
      style={style}
      title={title}
      aria-current={ariaCurrent}
      onClick={(e) => {
        // 새 탭 열기(⌘/Ctrl+클릭, 가운데 버튼)를 가로채지 않는다 —
        // 협업 검증에서 두 번째 탭을 여는 데 실제로 필요하다.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
