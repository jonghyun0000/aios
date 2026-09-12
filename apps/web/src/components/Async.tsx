import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * 비동기 데이터 로딩 훅.
 *
 * 라이브러리(react-query 등)를 쓰지 않는 이유: 캐시 무효화·낙관적 업데이트 같은
 * 고급 기능을 이 앱은 쓰지 않는다. 필요한 것은 loading/error/data 세 상태와
 * 수동 refetch뿐이고, 그건 40줄이면 된다.
 *
 * 언마운트 후 setState를 막는 처리가 들어 있다 — 없으면 페이지를 빠르게 넘길 때
 * 콘솔이 경고로 도배되고, 진짜 문제가 그 사이에 묻힌다.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // exhaustive-deps는 스프레드된 의존성 배열을 정적으로 검사할 수 없어 여기서만 끈다.
    // fn을 의존성에 넣지 않는 것이 의도다 — 호출자는 매 렌더마다 새 화살표 함수를 넘기므로
    // fn을 넣으면 무한 루프가 된다. 대신 호출자가 deps에 실제 의존값을 선언하는 계약이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function AsyncBoundary({
  loading, error, children, empty,
}: {
  loading: boolean;
  error: string | null;
  children: ReactNode;
  empty?: boolean;
}) {
  // role="status" 는 polite — 사용자가 하던 낭독을 끊지 않고 이어서 알린다.
  // 로딩 표시가 낭독되지 않으면 스크린리더 사용자는 화면이 멈춘 줄 안다.
  if (loading) return <div className="muted small" role="status">불러오는 중…</div>;
  // 오류는 assertive 여야 한다. 지금 하던 낭독을 끊고 즉시 알린다 —
  // 실패를 모른 채 계속 기다리게 두는 것이 더 나쁘다.
  if (error) return <div className="alert" role="alert">{error}</div>;
  if (empty) return <div className="muted small" role="status">표시할 항목이 없습니다.</div>;
  return <>{children}</>;
}
