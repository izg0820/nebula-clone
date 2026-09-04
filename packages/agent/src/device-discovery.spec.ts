import { parseDevicectlOutput } from './device-discovery';

/**
 * devicectl list devices --json-output 픽스처
 * 표준 출력은 hardwareProperties.platform('iOS') — deviceProperties.platformIdentifier는
 * 변형 출력 대비 (실기기 출력으로 확정 전까지 두 형태 모두 지원)
 */
const FIXTURE = {
  info: { jsonVersion: 2 },
  result: {
    devices: [
      {
        identifier: 'ABC-123',
        connectionProperties: { pairingState: 'paired', transportType: 'wired' },
        deviceProperties: { name: 'iPhone 13', osVersionNumber: '17.5.1' },
        hardwareProperties: { udid: '00008110-XXXX', platform: 'iOS', deviceType: 'iPhone' },
      },
      {
        identifier: 'LEGACY-1',
        connectionProperties: { pairingState: 'paired' },
        deviceProperties: {
          name: '레거시 형태 iPhone',
          osVersionNumber: '16.4',
          platformIdentifier: 'com.apple.platform.iphoneos',
        },
        hardwareProperties: { udid: '00008101-LLLL' },
      },
      {
        identifier: 'DEF-456',
        connectionProperties: { pairingState: 'unpaired' },
        deviceProperties: { name: '미페어링 iPhone', osVersionNumber: '17.0' },
        hardwareProperties: { udid: '00008110-YYYY', platform: 'iOS' },
      },
      {
        identifier: 'GHI-789',
        connectionProperties: { pairingState: 'paired' },
        deviceProperties: { name: 'Apple Watch', osVersionNumber: '10.0' },
        hardwareProperties: { udid: '00008310-ZZZZ', platform: 'watchOS' },
      },
    ],
  },
};

describe('parseDevicectlOutput', () => {
  test('페어링된 iOS 기기만 변환 — 표준(hardware.platform)·레거시(platformIdentifier) 모두 지원', () => {
    const devices = parseDevicectlOutput(FIXTURE);

    expect(devices).toEqual([
      { id: '00008110-XXXX', name: 'iPhone 13', platform: 'ios', osVersion: '17.5.1', tags: [] },
      {
        id: '00008101-LLLL',
        name: '레거시 형태 iPhone',
        platform: 'ios',
        osVersion: '16.4',
        tags: [],
      },
    ]);
  });

  test('watchOS·미페어링 기기 제외', () => {
    const ids = parseDevicectlOutput(FIXTURE).map((device) => device.id);

    expect(ids).not.toContain('00008310-ZZZZ');
    expect(ids).not.toContain('00008110-YYYY');
  });

  test('형식 불일치·필드 누락은 빈 배열 (throw 금지)', () => {
    expect(parseDevicectlOutput(null)).toEqual([]);
    expect(parseDevicectlOutput({})).toEqual([]);
    expect(parseDevicectlOutput({ result: { devices: 'not-array' } })).toEqual([]);
    expect(
      parseDevicectlOutput({
        result: {
          devices: [{ connectionProperties: { pairingState: 'paired' }, hardwareProperties: {} }],
        },
      }),
    ).toEqual([]);
  });
});
