import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { CommandOutcome } from '@nebula/shared';
import { AgentNotConnectedError, AgentsGateway } from '../agents/agents.gateway';
import { Device } from '../devices/device.types';
import { DevicesService } from '../devices/devices.service';
import { CommandsService } from './commands.service';

const OCCUPANT = 'occupant-1';

const occupiedDevice: Device = {
  id: 'udid-1',
  name: 'iPhone 13',
  platform: 'ios',
  osVersion: '17.5',
  tags: [],
  status: 'online',
  agentId: 'agent-1',
  occupantId: OCCUPANT,
  occupiedAt: '2026-09-04T00:00:00.000Z',
  lastHeartbeatAt: '2026-09-04T00:00:00.000Z',
};

const TAP = { kind: 'tap', x: 1, y: 2 } as const;

function createService(overrides: {
  device?: Device;
  outcome?: CommandOutcome;
  sendCommand?: jest.Mock;
}): CommandsService {
  const devicesService = {
    getById: jest.fn().mockReturnValue(overrides.device ?? occupiedDevice),
  } as unknown as DevicesService;
  const gateway = {
    sendCommand:
      overrides.sendCommand ??
      jest.fn().mockResolvedValue(overrides.outcome ?? { ok: true, result: 'done' }),
  } as unknown as AgentsGateway;
  return new CommandsService(devicesService, gateway);
}

describe('CommandsService', () => {
  test('점유자 일치 시 결과 반환', async () => {
    const service = createService({});

    await expect(service.execute('udid-1', OCCUPANT, TAP)).resolves.toBe('done');
  });

  test('점유자 불일치·미점유면 403', async () => {
    const service = createService({});
    const unoccupied = createService({ device: { ...occupiedDevice, occupantId: null } });

    await expect(service.execute('udid-1', 'wrong', TAP)).rejects.toThrow(ForbiddenException);
    await expect(unoccupied.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(ForbiddenException);
  });

  test('기기 오프라인이면 409', async () => {
    const service = createService({
      device: { ...occupiedDevice, status: 'offline', agentId: null },
    });

    await expect(service.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(ConflictException);
  });

  test('타임아웃이면 504, controller 실패면 502', async () => {
    const timedOut = createService({ outcome: { ok: false, error: 'timeout' } });
    const failed = createService({ outcome: { ok: false, error: 'controller 연결 실패' } });

    await expect(timedOut.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(
      GatewayTimeoutException,
    );
    await expect(failed.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(BadGatewayException);
  });

  test('Agent 터널 미연결이면 502', async () => {
    const service = createService({
      sendCommand: jest.fn().mockImplementation(() => {
        throw new AgentNotConnectedError('agent-1');
      }),
    });

    await expect(service.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(BadGatewayException);
  });
});
