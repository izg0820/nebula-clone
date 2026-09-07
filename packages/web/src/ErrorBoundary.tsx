import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly errorMessage: string | null;
}

/**
 * 최후 방어선 — 렌더·effect 예외로 루트가 언마운트되어 백지가 되는 것 방지
 * (React에 함수형 등가물이 없어 클래스 컴포넌트 필수)
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { errorMessage: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    if (error instanceof Error) return { errorMessage: error.message };
    return { errorMessage: String(error) };
  }

  render(): ReactNode {
    if (this.state.errorMessage === null) return this.props.children;
    return (
      <div className="placeholder" style={{ padding: 40 }}>
        <div className="big">화면 렌더링 오류</div>
        <div>{this.state.errorMessage}</div>
        <div style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
          <button
            className="btn"
            style={{ marginLeft: 8 }}
            onClick={() => {
              // 저장된 설정이 원인일 수 있음 (잘못된 서버 주소 등) — 초기화 후 재시작
              localStorage.clear();
              window.location.reload();
            }}
          >
            저장된 설정 초기화
          </button>
        </div>
      </div>
    );
  }
}
