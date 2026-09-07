/** 화면 pt 크기 (Controller /screenshot 응답) */
export interface ScreenSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface DevicePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 렌더된 이미지 위 클릭 좌표 → 기기 pt 좌표 환산
 * 이미지는 비율 유지로 표시된다고 가정 (offset은 이미지 요소 기준)
 */
export function toDevicePoint(
  offsetX: number,
  offsetY: number,
  renderedWidth: number,
  renderedHeight: number,
  screen: ScreenSize,
): DevicePoint {
  const x = (offsetX / renderedWidth) * screen.widthPt;
  const y = (offsetY / renderedHeight) * screen.heightPt;
  return { x: Math.round(x), y: Math.round(y) };
}

/** 화면 밖 릴리즈(포인터 캡처) 좌표를 기기 범위로 클램프 — 서버 좌표 검증(0~) 통과 보장 */
export function clampToScreen(point: DevicePoint, screen: ScreenSize): DevicePoint {
  return {
    x: Math.min(Math.max(point.x, 0), Math.round(screen.widthPt)),
    y: Math.min(Math.max(point.y, 0), Math.round(screen.heightPt)),
  };
}

/** 이 거리(pt) 미만의 드래그는 탭으로 판정 */
export const TAP_THRESHOLD_PT = 10;

const MIN_SWIPE_DURATION_MS = 100;
const MAX_SWIPE_DURATION_MS = 1_000;

export type Gesture =
  | { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'swipe';
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly durationMs: number;
    };

/** 포인터 다운→업 궤적 → 탭/스와이프 판정 (좌표는 클램프 후 반환) */
export function interpretGesture(
  from: DevicePoint,
  to: DevicePoint,
  elapsedMs: number,
  screen: ScreenSize,
): Gesture {
  const start = clampToScreen(from, screen);
  const end = clampToScreen(to, screen);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);

  if (distance < TAP_THRESHOLD_PT) return { kind: 'tap', x: start.x, y: start.y };

  const durationMs = Math.min(Math.max(elapsedMs, MIN_SWIPE_DURATION_MS), MAX_SWIPE_DURATION_MS);
  return {
    kind: 'swipe',
    fromX: start.x,
    fromY: start.y,
    toX: end.x,
    toY: end.y,
    durationMs,
  };
}
