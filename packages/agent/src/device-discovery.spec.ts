import { parseDevicectlOutput } from './device-discovery';

/** devicectl list devices --json-output 대표 형태 픽스처 */
const FIXTURE = {
  info: { jsonVersion: 2 },
  result: {
    devices: [
      {
        identifier: 'ABC-123',
        connectionProperties: { pairingState: 'paired', transportType: 'wired' },
        deviceProperties: {
          name: 'iPhone 13',
          osVersionNumber: '17.5.1',
          platformIdentifier: 'com.apple.platform.iphoneos',
        },
        hardwareProperties: { udid: '00008110-XXXX', deviceType: 'iPhone' },
      },
      {
        identifier: 'DEF-456',
        connectionProperties: { pairingState: 'unpaired' },
        deviceProperties: {
          name: '미페어링 iPhone',
          osVersionNumber: '17.0',
          platformIdentifier: 'com.apple.platform.iphoneos',
        },
        hardwareProperties: { udid: '00008110-YYYY' },
      },
      {
        identifier: 'GHI-789',
        connectionProperties: { pairingState: 'paired' },
        deviceProperties: {
          name: 'Apple Watch',
          osVersionNumber: '10.0',
          platformIdentifier: 'com.apple.platform.watchos',
        },
        hardwareProperties: { udid: '00008310-ZZZZ' },
      },
    ],
  },
};

describe('parseDevicectlOutput', () => {
  test('페어링된 iOS 기기만 등록 정보로 변환', () => {
    const devices = parseDevicectlOutput(FIXTURE);

    expect(devices).toEqual([
      {
        id: '00008110-XXXX',
        name: 'iPhone 13',
        platform: 'ios',
        osVersion: '17.5.1',
        tags: [],
      },
    ]);
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
