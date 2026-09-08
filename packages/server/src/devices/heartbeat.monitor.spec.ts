import { ConfigService } from '@nestjs/config';
import { DevicesService } from './devices.service';
import { HeartbeatMonitor } from './heartbeat.monitor';

function createConfig(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('HeartbeatMonitor', () => {
  test('sweep은 만료 처리를 서비스에 위임', () => {
    const expireStaleDevices = jest.fn().mockReturnValue(['udid-1']);
    const service = { expireStaleDevices } as unknown as DevicesService;
    const monitor = new HeartbeatMonitor(service, createConfig());

    monitor.sweep();

    expect(expireStaleDevices).toHaveBeenCalledTimes(1);
  });

  test('sweep 중 예외가 스윕 타이머를 죽이지 않음', () => {
    const expireStaleDevices = jest.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const service = { expireStaleDevices } as unknown as DevicesService;
    const monitor = new HeartbeatMonitor(service, createConfig());

    expect(() => monitor.sweep()).not.toThrow();
  });

  test('NEBULA_SWEEP_INTERVAL_MS 주기로 타이머 등록·종료 시 정리', () => {
    jest.useFakeTimers();
    const expireStaleDevices = jest.fn().mockReturnValue([]);
    const service = { expireStaleDevices } as unknown as DevicesService;
    const monitor = new HeartbeatMonitor(
      service,
      createConfig({ NEBULA_SWEEP_INTERVAL_MS: '5000' }),
    );

    monitor.onApplicationBootstrap();
    jest.advanceTimersByTime(15_000);
    expect(expireStaleDevices).toHaveBeenCalledTimes(3);

    monitor.onApplicationShutdown();
    jest.advanceTimersByTime(15_000);
    expect(expireStaleDevices).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});
