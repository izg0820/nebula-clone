import { AgentsGateway } from '../agents/agents.gateway';
import { Device } from '../devices/device.types';
import { DevicesService } from '../devices/devices.service';
import { OccupancyEvents } from '../devices/occupancy-events.service';
import { CommandRevocationListener } from './command-revocation.listener';

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

function createListener(getById: jest.Mock = jest.fn().mockReturnValue(device)): {
  events: OccupancyEvents;
  listener: CommandRevocationListener;
  revokeOccupancy: jest.Mock;
} {
  const events = new OccupancyEvents();
  const revokeOccupancy = jest.fn();
  const devicesService = { getById } as unknown as DevicesService;
  const agentsGateway = { revokeOccupancy } as unknown as AgentsGateway;
  const listener = new CommandRevocationListener(events, devicesService, agentsGateway);
  listener.onApplicationBootstrap();
  return { events, listener, revokeOccupancy };
}

describe('CommandRevocationListener', () => {
  test('점유 종료를 소유 Agent에 통지', () => {
    const { events, revokeOccupancy } = createListener();

    events.publishEnded({ deviceId: 'udid-1', occupantId: 'occupant-A', reason: 'released' });

    expect(revokeOccupancy).toHaveBeenCalledWith('udid-1', 'occupant-A', 'agent-1');
  });

  test('기기가 오프라인(agentId 없음)이면 통지 대상 없이 호출 — 대기 명령 정리는 게이트웨이 몫', () => {
    const { events, revokeOccupancy } = createListener(
      jest.fn().mockReturnValue({ ...device, agentId: null }),
    );

    events.publishEnded({ deviceId: 'udid-1', occupantId: 'occupant-A', reason: 'agent_stale' });

    expect(revokeOccupancy).toHaveBeenCalledWith('udid-1', 'occupant-A', null);
  });

  test('기기 조회 실패도 통지를 막지 않음 (404 등)', () => {
    const { events, revokeOccupancy } = createListener(
      jest.fn().mockImplementation(() => {
        throw new Error('기기 없음');
      }),
    );

    events.publishEnded({ deviceId: 'udid-1', occupantId: 'occupant-A', reason: 'idle_expired' });

    expect(revokeOccupancy).toHaveBeenCalledWith('udid-1', 'occupant-A', null);
  });

  test('셧다운 후에는 통지하지 않음', () => {
    const { events, listener, revokeOccupancy } = createListener();

    listener.onApplicationShutdown();
    events.publishEnded({ deviceId: 'udid-1', occupantId: 'occupant-A', reason: 'released' });

    expect(revokeOccupancy).not.toHaveBeenCalled();
  });
});
