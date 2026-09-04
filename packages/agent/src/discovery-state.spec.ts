import { DiscoveryState } from './discovery-state';
import { RegisterDeviceInput } from '@nebula/shared';

const IPHONE: RegisterDeviceInput = {
  id: 'u1',
  name: 'iPhone',
  platform: 'ios',
  osVersion: '17.5',
  tags: [],
};

describe('DiscoveryState', () => {
  test('성공 결과는 목록 교체 + 등록 필요 반환', () => {
    const state = new DiscoveryState();

    expect(state.apply([IPHONE])).toBe(true);
    expect(state.current).toEqual([IPHONE]);
  });

  test('실패(null)는 직전 목록 유지 + 등록 불필요', () => {
    const state = new DiscoveryState();
    state.apply([IPHONE]);

    expect(state.apply(null)).toBe(false);
    expect(state.current).toEqual([IPHONE]);
  });

  test('연속 실패가 임계치에 도달해야 목록을 비움', () => {
    const state = new DiscoveryState();
    state.apply([IPHONE]);

    state.apply(null);
    state.apply(null);
    state.apply(null);
    state.apply(null);
    expect(state.current).toEqual([IPHONE]);

    state.apply(null);
    expect(state.current).toEqual([]);
  });

  test('중간에 성공하면 실패 카운터 리셋', () => {
    const state = new DiscoveryState();
    state.apply([IPHONE]);

    state.apply(null);
    state.apply(null);
    state.apply([IPHONE]);
    state.apply(null);
    state.apply(null);
    state.apply(null);
    state.apply(null);

    expect(state.current).toEqual([IPHONE]);
  });
});
