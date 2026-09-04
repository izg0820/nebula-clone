import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Device } from './device.types';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

/** 저장소 목 기반 서비스 로직 검증 */
describe('DevicesService', () => {
  const sampleDevice: Device = {
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
  };

  function createRepositoryMock(overrides: Partial<DevicesRepository> = {}): DevicesRepository {
    return {
      upsertMany: jest.fn(),
      findAll: jest.fn().mockReturnValue([sampleDevice]),
      findById: jest.fn().mockReturnValue(sampleDevice),
      tryOccupy: jest.fn().mockReturnValue(sampleDevice),
      release: jest.fn().mockReturnValue('released'),
      heartbeat: jest.fn(),
      markAgentOffline: jest.fn(),
      markStaleOffline: jest.fn().mockReturnValue([]),
      ...overrides,
    };
  }

  test('occupy는 점유 성공 시 occupantId와 기기를 반환', () => {
    const service = new DevicesService(createRepositoryMock());

    const result = service.occupy({});

    expect(result.device).toEqual(sampleDevice);
    expect(result.occupantId).toEqual(expect.any(String));
  });

  test('occupy는 가용 기기 없으면 409', () => {
    const service = new DevicesService(
      createRepositoryMock({ tryOccupy: jest.fn().mockReturnValue(null) }),
    );

    expect(() => service.occupy({})).toThrow(ConflictException);
  });

  test('release는 점유자 불일치 시 403', () => {
    const service = new DevicesService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('forbidden') }),
    );

    expect(() => service.release('udid-1', 'wrong')).toThrow(ForbiddenException);
  });

  test('release는 미존재 기기면 404, 미점유면 409', () => {
    const notFound = new DevicesService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('not_found') }),
    );
    const notOccupied = new DevicesService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('not_occupied') }),
    );

    expect(() => notFound.release('x', 'o')).toThrow(NotFoundException);
    expect(() => notOccupied.release('udid-1', 'o')).toThrow(ConflictException);
  });

  test('expireStaleDevices는 하트비트 타임아웃 기준 cutoff로 위임', () => {
    const markStaleOffline = jest.fn().mockReturnValue(['udid-1']);
    const service = new DevicesService(createRepositoryMock({ markStaleOffline }));
    const before = Date.now();

    const staleIds = service.expireStaleDevices();

    expect(staleIds).toEqual(['udid-1']);
    const cutoff = new Date(markStaleOffline.mock.calls[0][0] as string).getTime();
    // cutoff = (now - 타임아웃) 근처 — 타임아웃 상수 변경 시에도 성립하도록 범위 검증
    expect(cutoff).toBeLessThan(before);
  });

  test('Agent 경유 메서드는 저장소로 위임 (register/heartbeat/disconnect)', () => {
    const repository = createRepositoryMock();
    const service = new DevicesService(repository);
    const input = [
      { id: 'u1', name: 'iPhone', platform: 'ios' as const, osVersion: '17.5', tags: [] },
    ];

    service.registerFromAgent(input, 'agent-1');
    service.recordHeartbeat(['u1'], 'agent-1');
    service.handleAgentDisconnect('agent-1');

    expect(repository.upsertMany).toHaveBeenCalledWith(input, 'agent-1', expect.any(String));
    expect(repository.heartbeat).toHaveBeenCalledWith(['u1'], 'agent-1', expect.any(String));
    expect(repository.markAgentOffline).toHaveBeenCalledWith('agent-1');
  });

  test('getById는 미존재 기기면 404', () => {
    const service = new DevicesService(
      createRepositoryMock({ findById: jest.fn().mockReturnValue(null) }),
    );

    expect(() => service.getById('없음')).toThrow(NotFoundException);
  });
});
