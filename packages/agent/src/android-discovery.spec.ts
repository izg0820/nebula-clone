import { AdbClient } from './adb-client';
import { AndroidDiscoverySource, parseAdbDevices } from './android-discovery';

const LISTING = [
  'List of devices attached',
  'R3CX90ABCDE\tdevice usb:34603008X product:q8q_kor model:SM_F966N device:q8q transport_id:2',
  'UNAUTH123\tunauthorized usb:34603009X transport_id:3',
  'OFF456\toffline transport_id:4',
  '192.168.0.5:5555\tdevice product:q8q model:SM_F966N device:q8q transport_id:5',
  '',
].join('\n');

function createAdb(overrides: Partial<Record<keyof AdbClient, jest.Mock>> = {}): {
  adb: AdbClient;
  listDevices: jest.Mock;
  getProp: jest.Mock;
} {
  const listDevices = overrides.listDevices ?? jest.fn().mockResolvedValue(LISTING);
  const getProp = overrides.getProp ?? jest.fn().mockResolvedValue('17');
  return { adb: { listDevices, getProp } as unknown as AdbClient, listDevices, getProp };
}

describe('parseAdbDevices', () => {
  test('헤더·빈 줄 스킵, serial/state/model 추출 (model _ → 공백)', () => {
    const entries = parseAdbDevices(LISTING);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ serial: 'R3CX90ABCDE', state: 'device', model: 'SM F966N' });
    expect(entries[1]).toEqual({ serial: 'UNAUTH123', state: 'unauthorized', model: null });
    expect(entries[2].state).toBe('offline');
  });

  test('데몬 기동 메시지(* 접두)와 형식 미달 줄 무시', () => {
    const raw = '* daemon started successfully\nList of devices attached\nlonely\n';
    expect(parseAdbDevices(raw)).toEqual([]);
  });
});

describe('AndroidDiscoverySource', () => {
  test('device 상태 + 유효 serial만 등록 — unauthorized·offline·무선(host:port) 제외', async () => {
    const { adb } = createAdb();
    const source = new AndroidDiscoverySource(adb);

    const devices = await source.discover();

    expect(devices).toEqual([
      {
        id: 'R3CX90ABCDE',
        name: 'SM F966N',
        platform: 'android',
        osVersion: '17',
        tags: [],
      },
    ]);
  });

  test('osVersion은 serial별 캐시 — 두 번째 발견에서 getProp 미호출', async () => {
    const { adb, getProp } = createAdb();
    const source = new AndroidDiscoverySource(adb);

    await source.discover();
    await source.discover();

    expect(getProp).toHaveBeenCalledTimes(1);
  });

  test('getProp 실패는 unknown으로 등록 (기기 자체는 보이게)', async () => {
    const { adb } = createAdb({ getProp: jest.fn().mockRejectedValue(new Error('adb 오류')) });
    const source = new AndroidDiscoverySource(adb);

    const devices = await source.discover();

    expect(devices?.[0]?.osVersion).toBe('unknown');
  });

  test('adb 목록 실패는 null (발견 실패 — 기기 없음 []과 구별)', async () => {
    const { adb } = createAdb({
      listDevices: jest.fn().mockRejectedValue(new Error('adb 미기동')),
    });
    const source = new AndroidDiscoverySource(adb);

    expect(await source.discover()).toBeNull();
  });
});
