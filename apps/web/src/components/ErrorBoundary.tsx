import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 화면 단위 에러 경계.
 *
 * 왜 필요한가: React는 렌더 중 예외가 나면 트리 전체를 언마운트한다.
 * 즉 메시지 하나의 형태가 예상과 다른 것만으로 **앱 전체가 백지**가 된다.
 * 실제로 그렇게 됐다 — messages.content가 문자열이 아니라 jsonb였고,
 * 그 한 필드 때문에 사이드바까지 사라져 사용자가 다른 페이지로 갈 수조차 없었다.
 *
 * 경계를 화면 콘텐츠에만 두고 사이드바 바깥에 두지 않는 이유가 이것이다.
 * 한 화면이 죽어도 나머지 앱은 계속 쓸 수 있어야 한다.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 콘솔에 남긴다. 프로덕션에서는 여기서 에러 수집 서비스로 보내면 된다.
    console.error("화면 렌더링 실패", error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    // 경로가 바뀌면 자동으로 회복한다. 그러지 않으면 한 번 깨진 뒤
    // 다른 메뉴를 눌러도 계속 에러 화면이 남는다.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="main-narrow">
        <h1>이 화면을 표시할 수 없습니다</h1>
        <p className="page-sub">
          다른 메뉴는 정상 동작합니다. 아래는 개발자를 위한 원본 오류입니다.
        </p>
        <div className="alert">
          <strong>{this.state.error.name}</strong>: {this.state.error.message}
        </div>
        <button onClick={() => this.setState({ error: null })}>다시 시도</button>
      </div>
    );
  }
}
