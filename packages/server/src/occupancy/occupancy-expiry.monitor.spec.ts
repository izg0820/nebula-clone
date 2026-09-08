import { ConfigService } from '@nestjs/config';
import { VIEWER_CLOSE_OCCUPATION_EXPIRED } from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { StreamsRelayService } from '../streams/streams-relay.service';
import { OccupancyExpiryMonitor } from './occupancy-expiry.monitor';

function createMonitor(expireResult: () => string[]): {
  monitor: OccupancyExpiryMonitor;
  closeViewers: jest.Mock;
} {
  const devicesService = {
    expireIdleOccupations: jest.fn().mockImplementation(expireResult),
  } as unknown as DevicesService;
  const closeViewers = jest.fn();
  const relay = { closeViewers } as unknown as StreamsRelayService;
  const config = { get: () => undefined } as unknown as ConfigService;
  return { monitor: new OccupancyExpiryMonitor(devicesService, relay, config), closeViewers };
}

describe('OccupancyExpiryMonitor', () => {
  test('회수된 기기마다 시청자를 4408로 종료', () => {
    const { monitor, closeViewers } = createMonitor(() => ['udid-1', 'udid-2']);

    monitor.sweep();

    expect(closeViewers).toHaveBeenCalledTimes(2);
    expect(closeViewers).toHaveBeenCalledWith(
      'udid-1',
      VIEWER_CLOSE_OCCUPATION_EXPIRED,
      'occupation expired',
    );
    expect(closeViewers).toHaveBeenCalledWith(
      'udid-2',
      VIEWER_CLOSE_OCCUPATION_EXPIRED,
      'occupation expired',
    );
  });

  test('회수 없으면 릴레이 미호출', () => {
    const { monitor, closeViewers } = createMonitor(() => []);

    monitor.sweep();

    expect(closeViewers).not.toHaveBeenCalled();
  });

  test('서비스 예외를 삼켜 크론이 죽지 않음', () => {
    const { monitor } = createMonitor(() => {
      throw new Error('DB 오류');
    });

    expect(() => monitor.sweep()).not.toThrow();
  });
});
