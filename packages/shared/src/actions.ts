/** 기기 조작 액션 — 서버 API·WS 터널·Controller HTTP가 공유하는 단일 정의 */

export interface TapAction {
  readonly kind: 'tap';
  readonly x: number;
  readonly y: number;
}

export interface SwipeAction {
  readonly kind: 'swipe';
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

export interface TypeTextAction {
  readonly kind: 'typeText';
  readonly text: string;
}

export interface UiDumpAction {
  readonly kind: 'uiDump';
}

export type DeviceAction = TapAction | SwipeAction | TypeTextAction | UiDumpAction;

/** 명령 실행 결과 — 성공 시 result, 실패 시 error */
export type CommandOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

/** 인프라 계층 실패 코드 — 문자열 비교 대신 이 상수 사용 (Agent가 임의로 쓰면 안 되는 값) */
export const COMMAND_ERROR_TIMEOUT = 'timeout';
export const COMMAND_ERROR_AGENT_DISCONNECTED = 'agent_disconnected';
