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

/** 화면 캡처 — 서버 계약 결과: { jpegBase64, coordWidth, coordHeight } (탭 좌표 기준계 크기) */
export interface ScreenshotAction {
  readonly kind: 'screenshot';
}

/** 하드웨어 버튼 종류 — back은 Android 전용 (iOS 러너는 home만 지원, back은 400) */
export type HardwareButton = 'home' | 'back';

const HARDWARE_BUTTONS: readonly HardwareButton[] = ['home', 'back'];

/** 신뢰 경계 검증용 타입 가드 */
export function isHardwareButton(value: unknown): value is HardwareButton {
  return HARDWARE_BUTTONS.includes(value as HardwareButton);
}

/** 하드웨어 버튼 — home: 홈 화면 이동, back: Android 뒤로 (iOS의 '뒤로'는 엣지 스와이프) */
export interface PressButtonAction {
  readonly kind: 'pressButton';
  readonly button: HardwareButton;
}

export type DeviceAction =
  | TapAction
  | SwipeAction
  | TypeTextAction
  | UiDumpAction
  | ScreenshotAction
  | PressButtonAction;

/** 전체 액션 종류 — Agent가 register 시 스펙 교환에 사용 */
export const DEVICE_ACTION_KINDS: readonly DeviceAction['kind'][] = [
  'tap',
  'swipe',
  'typeText',
  'uiDump',
  'screenshot',
  'pressButton',
];

/** 명령 실행 결과 — 성공 시 result, 실패 시 error */
export type CommandOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

/** 인프라 계층 실패 코드 — 문자열 비교 대신 이 상수 사용 (Agent가 임의로 쓰면 안 되는 값) */
export const COMMAND_ERROR_TIMEOUT = 'timeout';
export const COMMAND_ERROR_AGENT_DISCONNECTED = 'agent_disconnected';
/** Agent가 스펙 교환에 포함하지 않은 액션 — 혼합 버전 배포 시 타임아웃 대신 즉시 거부 */
export const COMMAND_ERROR_UNSUPPORTED = 'unsupported_action';
