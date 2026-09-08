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
  lastActivityAt: '2026-09-04T00:00:00.000Z',
};

const TAP = { kind: 'tap', x: 1, y: 2 } as const;

interface ServiceFixture {
  readonly service: CommandsService;
  readonly renewOccupation: jest.Mock;
  readonly sendCommand: jest.Mock;
}

function createFixture(overrides: {
  device?: Device;
  outcome?: CommandOutcome;
  sendCommand?: jest.Mock;
  renewOccupation?: jest.Mock;
}): ServiceFixture {
  const device = overrides.device ?? occupiedDevice;
  const renewOccupation = overrides.renewOccupation ?? jest.fn().mockReturnValue(device);
  const devicesService = {
    getById: jest.fn().mockReturnValue(device),
    renewOccupation,
  } as unknown as DevicesService;
  const sendCommand =
    overrides.sendCommand ??
    jest.fn().mockResolvedValue(overrides.outcome ?? { ok: true, result: 'done' });
  const gateway = { sendCommand } as unknown as AgentsGateway;
  return { service: new CommandsService(devicesService, gateway), renewOccupation, sendCommand };
}

function createService(overrides: {
  device?: Device;
  outcome?: CommandOutcome;
  sendCommand?: jest.Mock;
}): CommandsService {
  return createFixture(overrides).service;
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

  test('명령 = 점유 활동 — renewOccupation이 Agent 전송보다 먼저 호출됨', async () => {
    const callOrder: string[] = [];
    const renewOccupation = jest.fn().mockImplementation(() => {
      callOrder.push('renew');
      return occupiedDevice;
    });
    const sendCommand = jest.fn().mockImplementation(async () => {
      callOrder.push('send');
      return { ok: true, result: 'done' };
    });
    const { service } = createFixture({ renewOccupation, sendCommand });

    await service.execute('udid-1', OCCUPANT, TAP);

    expect(renewOccupation).toHaveBeenCalledWith('udid-1', OCCUPANT);
    expect(callOrder).toEqual(['renew', 'send']);
  });

  test('점유자 불일치·오프라인 실패 시 renewOccupation 미호출', async () => {
    const mismatch = createFixture({});
    await expect(mismatch.service.execute('udid-1', 'wrong', TAP)).rejects.toThrow(
      ForbiddenException,
    );
    expect(mismatch.renewOccupation).not.toHaveBeenCalled();

    const offline = createFixture({
      device: { ...occupiedDevice, status: 'offline', agentId: null },
    });
    await expect(offline.service.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(
      ConflictException,
    );
    expect(offline.renewOccupation).not.toHaveBeenCalled();
  });

  test('renewOccupation이 403을 던지면(만료 레이스) 명령 실패 + Agent 전송 없음', async () => {
    const { service, sendCommand } = createFixture({
      renewOccupation: jest.fn().mockImplementation(() => {
        throw new ForbiddenException('점유자 불일치');
      }),
    });

    await expect(service.execute('udid-1', OCCUPANT, TAP)).rejects.toThrow(ForbiddenException);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
