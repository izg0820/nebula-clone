import { ConfigService } from '@nestjs/config';
import { FRAME_FORMAT_H264 } from '@nebula/shared';
import type { WebSocket } from 'ws';
import { Device } from '../devices/device.types';
import { DevicesRepository } from '../devices/devices.repository';
import { DevicesService } from '../devices/devices.service';
import { OccupancyEvents } from '../devices/occupancy-events.service';
import { StreamsRelayService } from '../streams/streams-relay.service';
import { StreamRevocationListener } from './stream-revocation.listener';

/** 스스로 닫히지 않는 시청자 — 클라이언트 정리에 기대지 않는지 검증하려면 OPEN을 유지해야 함 */
class FakeViewer {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  closedWith: Array<{ code: number; reason: string }> = [];

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  terminate(): void {}

  close(code: number, reason: string): void {
    this.closedWith.push({ code, reason });
  }
}

const device: Device = {
  id: 'udid-1',
  name: 'iPhone 13',
  platform: 'ios',
  osVersion: '17.5',
  tags: [],
  status: 'online',
  agentId: 'agent-1',
  occupantId: null,
  occupiedAt: null,
  lastHeartbeatAt: null,
  lastActivityAt: null,
};

function createRepositoryMock(overrides: Partial<DevicesRepository> = {}): DevicesRepository {
  return {
    upsertMany: jest.fn(),
    findAll: jest.fn().mockReturnValue([device]),
    findById: jest.fn().mockReturnValue(device),
    tryOccupy: jest.fn().mockReturnValue(device),
    release: jest.fn().mockReturnValue('released'),
    renewOccupation: jest.fn().mockReturnValue('renewed'),
    expireIdleOccupations: jest.fn().mockReturnValue([]),
    heartbeat: jest.fn(),
    markAgentOffline: jest.fn(),
    markStaleOffline: jest.fn().mockReturnValue([]),
    ...overrides,
  };
}

/** 실제 버스·릴레이·서비스를 그대로 배선 — 점유 종료 경로 전체가 이어졌는지 확인 */
function createWiring(repository: DevicesRepository = createRepositoryMock()): {
  devicesService: DevicesService;
  relay: StreamsRelayService;
  listener: StreamRevocationListener;
} {
  const events = new OccupancyEvents();
  const relay = new StreamsRelayService();
  const config = { get: () => undefined } as unknown as ConfigService;
  const devicesService = new DevicesService(repository, events, config);
  const listener = new StreamRevocationListener(events, relay);
  listener.onApplicationBootstrap();
  return { devicesService, relay, listener };
}

function broadcastFrame(relay: StreamsRelayService): void {
  relay.broadcast({
    deviceId: 'udid-1',
    format: FRAME_FORMAT_H264,
    isKey: true,
    width: 1,
    height: 1,
    stampMs: 0,
    payload: new Uint8Array([0x01]),
  });
}

describe('StreamRevocationListener', () => {
  test('명시 해제는 그 점유자의 시청 소켓을 서버가 끊음', () => {
    const { devicesService, relay } = createWiring();
    const viewer = new FakeViewer();
    relay.addViewer('udid-1', 'occupant-A', viewer as unknown as WebSocket);

    devicesService.release('udid-1', 'occupant-A');

    expect(viewer.closedWith).toEqual([{ code: 4408, reason: 'occupation released' }]);
  });

  test('해제 후 재점유해도 이전 점유자 소켓에는 프레임이 가지 않음', () => {
    const { devicesService, relay } = createWiring();
    const previous = new FakeViewer();
    const current = new FakeViewer();
    relay.addViewer('udid-1', 'occupant-A', previous as unknown as WebSocket);

    // A 해제 → B 재점유 → B가 새 소켓으로 시청
    devicesService.release('udid-1', 'occupant-A');
    relay.addViewer('udid-1', 'occupant-B', current as unknown as WebSocket);
    broadcastFrame(relay);

    expect(previous.sent).toHaveLength(0);
    expect(current.sent).toHaveLength(1);
  });

  test('유휴 만료 회수도 같은 경로로 시청을 끊음', () => {
    const { devicesService, relay } = createWiring(
      createRepositoryMock({
        expireIdleOccupations: jest
          .fn()
          .mockReturnValue([{ deviceId: 'udid-1', occupantId: 'occupant-A' }]),
      }),
    );
    const viewer = new FakeViewer();
    relay.addViewer('udid-1', 'occupant-A', viewer as unknown as WebSocket);

    devicesService.expireIdleOccupations();

    expect(viewer.closedWith).toEqual([{ code: 4408, reason: 'occupation expired' }]);
  });

  test('하트비트 만료 회수도 같은 경로로 시청을 끊음', () => {
    const { devicesService, relay } = createWiring(
      createRepositoryMock({
        markStaleOffline: jest
          .fn()
          .mockReturnValue([{ deviceId: 'udid-1', occupantId: 'occupant-A' }]),
      }),
    );
    const viewer = new FakeViewer();
    relay.addViewer('udid-1', 'occupant-A', viewer as unknown as WebSocket);

    devicesService.expireStaleDevices();

    expect(viewer.closedWith).toEqual([{ code: 4408, reason: 'device offline' }]);
  });

  test('종료 구독 해지 후에는 회수하지 않음 (셧다운)', () => {
    const { devicesService, relay, listener } = createWiring();
    const viewer = new FakeViewer();
    relay.addViewer('udid-1', 'occupant-A', viewer as unknown as WebSocket);

    listener.onApplicationShutdown();
    devicesService.release('udid-1', 'occupant-A');

    expect(viewer.closedWith).toHaveLength(0);
  });
});
