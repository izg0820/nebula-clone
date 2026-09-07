import { describe, expect, test } from 'vitest';
import { toDevicePoint } from './coordinates';

describe('toDevicePoint', () => {
  const SCREEN = { widthPt: 430, heightPt: 932 };

  test('렌더 크기와 기기 pt 크기 비율로 환산', () => {
    // 절반 크기로 렌더된 이미지의 중앙 클릭 → 기기 화면 중앙
    expect(toDevicePoint(107.5, 233, 215, 466, SCREEN)).toEqual({ x: 215, y: 466 });
  });

  test('모서리 클릭은 기기 좌표 경계로', () => {
    expect(toDevicePoint(0, 0, 215, 466, SCREEN)).toEqual({ x: 0, y: 0 });
    expect(toDevicePoint(215, 466, 215, 466, SCREEN)).toEqual({ x: 430, y: 932 });
  });
});
