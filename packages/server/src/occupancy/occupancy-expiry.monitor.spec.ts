import { ConfigService } from '@nestjs/config';
import { EndedOccupation } from '../devices/device.types';
import { DevicesService } from '../devices/devices.service';
import { OccupancyExpiryMonitor } from './occupancy-expiry.monitor';

function createMonitor(expireResult: () => EndedOccupation[]): {
  monitor: OccupancyExpiryMonitor;
  expireIdleOccupations: jest.Mock;
} {
  const expireIdleOccupations = jest.fn().mockImplementation(expireResult);
  const devicesService = { expireIdleOccupations } as unknown as DevicesService;
  const config = { get: () => undefined } as unknown as ConfigService;
  return { monitor: new OccupancyExpiryMonitor(devicesService, config), expireIdleOccupations };
}

describe('OccupancyExpiryMonitor', () => {
  // 시청자 종료는 StreamRevocationListener 담당 — 여기선 회수 호출만 책임
  test('스윕은 유휴 점유 회수를 호출', () => {
    const { monitor, expireIdleOccupations } = createMonitor(() => [
      { deviceId: 'udid-1', occupantId: 'occupant-1' },
    ]);

    monitor.sweep();

    expect(expireIdleOccupations).toHaveBeenCalledTimes(1);
  });

  test('회수 없으면 조용히 종료', () => {
    const { monitor } = createMonitor(() => []);

    expect(() => monitor.sweep()).not.toThrow();
  });

  test('서비스 예외를 삼켜 크론이 죽지 않음', () => {
    const { monitor } = createMonitor(() => {
      throw new Error('DB 오류');
    });

    expect(() => monitor.sweep()).not.toThrow();
  });
});
