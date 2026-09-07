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
