import { Device, toPublicDevice } from './device.types';

const DEVICE: Device = {
  id: 'udid-1',
  name: 'iPhone',
  platform: 'ios',
  osVersion: '26.0',
  tags: ['controller-ready'],
  status: 'online',
  agentId: 'agent-1',
  occupantId: 'secret-occupant',
  occupiedAt: '2026-09-04T00:00:00.000Z',
  lastHeartbeatAt: '2026-09-04T00:00:00.000Z',
  lastActivityAt: '2026-09-04T00:00:00.000Z',
};

describe('toPublicDevice', () => {
  test('occupantId(해제 권한 비밀값)를 응답 형태에서 제거 — 최상위 불변식', () => {
    const publicDevice = toPublicDevice(DEVICE);

    expect(Object.keys(publicDevice)).not.toContain('occupantId');
    expect(publicDevice.isOccupied).toBe(true);
  });

  test('미점유 기기는 isOccupied=false', () => {
    const publicDevice = toPublicDevice({ ...DEVICE, occupantId: null, occupiedAt: null });

    expect(publicDevice.isOccupied).toBe(false);
    expect(Object.keys(publicDevice)).not.toContain('occupantId');
  });
});
