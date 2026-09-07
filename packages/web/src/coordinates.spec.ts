import { describe, expect, test } from 'vitest';
import { clampToScreen, interpretGesture, toDevicePoint } from './coordinates';

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

describe('clampToScreen', () => {
  const SCREEN = { widthPt: 430, heightPt: 932 };

  test('화면 밖 좌표(캡처 릴리즈)를 경계로 클램프', () => {
    expect(clampToScreen({ x: -50, y: 1000 }, SCREEN)).toEqual({ x: 0, y: 932 });
    expect(clampToScreen({ x: 500, y: -3 }, SCREEN)).toEqual({ x: 430, y: 0 });
  });
});

describe('interpretGesture', () => {
  const SCREEN = { widthPt: 430, heightPt: 932 };

  test('임계 거리 미만은 탭 (시작점 기준)', () => {
    expect(interpretGesture({ x: 100, y: 100 }, { x: 105, y: 103 }, 80, SCREEN)).toEqual({
      kind: 'tap',
      x: 100,
      y: 100,
    });
  });

  test('임계 이상 드래그는 스와이프, 드래그 시간 반영 (100~1000ms 클램프)', () => {
    const fast = interpretGesture({ x: 100, y: 500 }, { x: 100, y: 200 }, 30, SCREEN);
    expect(fast).toMatchObject({ kind: 'swipe', fromY: 500, toY: 200, durationMs: 100 });

    const slow = interpretGesture({ x: 100, y: 500 }, { x: 100, y: 200 }, 5000, SCREEN);
    expect(slow).toMatchObject({ kind: 'swipe', durationMs: 1000 });
  });

  test('화면 밖 릴리즈는 클램프된 좌표로 스와이프 (서버 검증 통과)', () => {
    const gesture = interpretGesture({ x: 400, y: 466 }, { x: 600, y: 466 }, 300, SCREEN);
    expect(gesture).toMatchObject({ kind: 'swipe', fromX: 400, toX: 430 });
  });
});
