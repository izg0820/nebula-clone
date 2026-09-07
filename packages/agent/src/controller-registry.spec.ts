import { StaticControllerRegistry } from './controller-registry';

describe('StaticControllerRegistry', () => {
  test('등록된 기기의 baseUrl 해석, 미등록은 null', () => {
    const registry = new StaticControllerRegistry(new Map([['u1', 8100]]));

    expect(registry.resolve('u1')).toBe('http://127.0.0.1:8100');
    expect(registry.resolve('없음')).toBeNull();
  });

  test('정적 모드는 등록된 기기를 항상 준비 상태로 간주', () => {
    const registry = new StaticControllerRegistry(new Map([['u1', 8100]]));

    expect(registry.isReady('u1')).toBe(true);
    expect(registry.isReady('없음')).toBe(false);
  });
});
