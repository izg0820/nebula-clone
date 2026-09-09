import { CompositeResolver } from './composite-resolver';
import { ControllerEndpointResolver } from './controller-registry';

function resolver(owned: Record<string, { url: string; ready: boolean }>): ControllerEndpointResolver {
  return {
    resolve: (deviceId) => owned[deviceId]?.url ?? null,
    isReady: (deviceId) => owned[deviceId]?.ready === true,
  };
}

describe('CompositeResolver', () => {
  const ios = resolver({ 'ios-1': { url: 'http://127.0.0.1:8200', ready: true } });
  const android = resolver({ 'and-1': { url: 'http://127.0.0.1:8300', ready: false } });

  test('기기를 소유한 resolver가 담당', () => {
    const composite = new CompositeResolver([ios, android]);

    expect(composite.resolve('ios-1')).toBe('http://127.0.0.1:8200');
    expect(composite.resolve('and-1')).toBe('http://127.0.0.1:8300');
    expect(composite.resolve('없음')).toBeNull();
  });

  test('isReady는 소유 resolver의 준비 상태만 반영', () => {
    const composite = new CompositeResolver([ios, android]);

    expect(composite.isReady('ios-1')).toBe(true);
    expect(composite.isReady('and-1')).toBe(false);
    expect(composite.isReady('없음')).toBe(false);
  });
});
