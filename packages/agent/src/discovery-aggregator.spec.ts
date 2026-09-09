import { DevicePlatform, RegisterDeviceInput } from '@nebula/shared';
import { DiscoveryAggregator } from './discovery-aggregator';
import { DiscoverySource } from './discovery-source';

function device(id: string, platform: DevicePlatform): RegisterDeviceInput {
  return { id, name: id, platform, osVersion: '1', tags: [] };
}

/** 회차별 결과를 순서대로 반환하는 가짜 소스 */
function createSource(
  platform: DevicePlatform,
  results: ReadonlyArray<readonly RegisterDeviceInput[] | null>,
): DiscoverySource {
  let call = 0;
  return {
    platform,
    discover: async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  };
}

const IOS_DEVICE = device('ios-1', 'ios');
const ANDROID_DEVICE = device('and-1', 'android');

describe('DiscoveryAggregator', () => {
  test('부분 실패 격리 — iOS 실패(null)여도 Android 성공분은 등록되고 iOS 직전 목록 유지', async () => {
    const ios = createSource('ios', [[IOS_DEVICE], null]);
    const android = createSource('android', [[ANDROID_DEVICE], [ANDROID_DEVICE]]);
    const aggregator = new DiscoveryAggregator([ios, android], []);

    await aggregator.refresh();
    expect(await aggregator.refresh()).toBe(true);

    const ids = aggregator.devices.map((entry) => entry.id).sort();
    expect(ids).toEqual(['and-1', 'ios-1']);
  });

  test('플랫폼별 실패 카운터 독립 — iOS 5회 연속 실패 시 iOS만 목록에서 빠짐', async () => {
    const ios = createSource('ios', [[IOS_DEVICE], null, null, null, null, null]);
    const android = createSource('android', [[ANDROID_DEVICE]]);
    const aggregator = new DiscoveryAggregator([ios, android], []);

    for (let i = 0; i < 6; i += 1) await aggregator.refresh();

    expect(aggregator.devices.map((entry) => entry.id)).toEqual(['and-1']);
  });

  test('소스 예외는 실패(null)로 흡수 — 다른 소스에 영향 없음', async () => {
    const throwing: DiscoverySource = {
      platform: 'ios',
      discover: async () => {
        throw new Error('devicectl 폭발');
      },
    };
    const android = createSource('android', [[ANDROID_DEVICE]]);
    const aggregator = new DiscoveryAggregator([throwing, android], []);

    expect(await aggregator.refresh()).toBe(true);
    expect(aggregator.devices.map((entry) => entry.id)).toEqual(['and-1']);
  });

  test('정적 기기 병합(id 중복은 정적 우선) + 정적만 있어도 shouldRegister', async () => {
    const staticDevice = { ...device('and-1', 'android'), name: '정적' };
    const android = createSource('android', [null]);
    const aggregator = new DiscoveryAggregator([android], [staticDevice]);

    expect(await aggregator.refresh()).toBe(true);
    expect(aggregator.devices).toEqual([staticDevice]);
  });

  test('discoveredIds는 플랫폼별 + 정적 제외 — 수퍼바이저 입력용', async () => {
    const staticDevice = device('static-ios', 'ios');
    const ios = createSource('ios', [[IOS_DEVICE, staticDevice]]);
    const android = createSource('android', [[ANDROID_DEVICE]]);
    const aggregator = new DiscoveryAggregator([ios, android], [staticDevice]);

    await aggregator.refresh();

    expect(aggregator.discoveredIds('ios')).toEqual(['ios-1']);
    expect(aggregator.discoveredIds('android')).toEqual(['and-1']);
  });
});
