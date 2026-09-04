import { DevicesService } from './devices.service';
import { HeartbeatMonitor } from './heartbeat.monitor';

describe('HeartbeatMonitor', () => {
  test('sweep은 만료 처리를 서비스에 위임', () => {
    const expireStaleDevices = jest.fn().mockReturnValue(['udid-1']);
    const service = { expireStaleDevices } as unknown as DevicesService;
    const monitor = new HeartbeatMonitor(service);

    monitor.sweep();

    expect(expireStaleDevices).toHaveBeenCalledTimes(1);
  });

  test('sweep 중 예외가 크론 스케줄러를 죽이지 않음', () => {
    const expireStaleDevices = jest.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const service = { expireStaleDevices } as unknown as DevicesService;
    const monitor = new HeartbeatMonitor(service);

    expect(() => monitor.sweep()).not.toThrow();
  });
});
