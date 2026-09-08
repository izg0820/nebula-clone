import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    lastActivityAt: null,
  };

  function createRepositoryMock(overrides: Partial<DevicesRepository> = {}): DevicesRepository {
    return {
      upsertMany: jest.fn(),
      findAll: jest.fn().mockReturnValue([sampleDevice]),
      findById: jest.fn().mockReturnValue(sampleDevice),
      tryOccupy: jest.fn().mockReturnValue(sampleDevice),
      release: jest.fn().mockReturnValue('released'),
      renewOccupation: jest.fn().mockReturnValue('renewed'),
      expireIdleOccupations: jest.fn().mockReturnValue([]),
      heartbeat: jest.fn(),
      markAgentOffline: jest.fn(),
      markStaleOffline: jest.fn().mockReturnValue([]),
      ...overrides,
    };
  }

  /** env 미설정이 기본 — 필요한 테스트만 NEBULA_OCCUPATION_TTL_MS 주입 */
  function createConfigMock(env: Record<string, string> = {}): ConfigService {
    return { get: (key: string) => env[key] } as unknown as ConfigService;
  }

  function createService(
    repository: DevicesRepository = createRepositoryMock(),
    env: Record<string, string> = {},
  ): DevicesService {
    return new DevicesService(repository, createConfigMock(env));
  }

  test('occupy는 점유 성공 시 occupantId와 기기를 반환', () => {
    const service = createService(createRepositoryMock());

    const result = service.occupy({});

    expect(result.device).toEqual(sampleDevice);
    expect(result.occupantId).toEqual(expect.any(String));
  });

  test('occupy는 가용 기기 없으면 409', () => {
    const service = createService(
      createRepositoryMock({ tryOccupy: jest.fn().mockReturnValue(null) }),
    );

    expect(() => service.occupy({})).toThrow(ConflictException);
  });

  test('release는 점유자 불일치 시 403', () => {
    const service = createService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('forbidden') }),
    );

    expect(() => service.release('udid-1', 'wrong')).toThrow(ForbiddenException);
  });

  test('release는 미존재 기기면 404, 미점유면 409', () => {
    const notFound = createService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('not_found') }),
    );
    const notOccupied = createService(
      createRepositoryMock({ release: jest.fn().mockReturnValue('not_occupied') }),
    );

    expect(() => notFound.release('x', 'o')).toThrow(NotFoundException);
    expect(() => notOccupied.release('udid-1', 'o')).toThrow(ConflictException);
  });

  test('expireStaleDevices는 하트비트 타임아웃 기준 cutoff로 위임', () => {
    const markStaleOffline = jest.fn().mockReturnValue(['udid-1']);
    const service = createService(createRepositoryMock({ markStaleOffline }));
    const before = Date.now();

    const staleIds = service.expireStaleDevices();

    expect(staleIds).toEqual(['udid-1']);
    const cutoff = new Date(markStaleOffline.mock.calls[0][0] as string).getTime();
    // cutoff = (now - 타임아웃) 근처 — 타임아웃 상수 변경 시에도 성립하도록 범위 검증
    expect(cutoff).toBeLessThan(before);
  });

  test('Agent 경유 메서드는 저장소로 위임 (register/heartbeat/disconnect)', () => {
    const repository = createRepositoryMock();
    const service = createService(repository);
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
    const service = createService(
      createRepositoryMock({ findById: jest.fn().mockReturnValue(null) }),
    );

    expect(() => service.getById('없음')).toThrow(NotFoundException);
  });

  test('renewOccupation은 실패 사유를 HTTP 예외로 매핑 (403/404/409)', () => {
    const forbidden = createService(
      createRepositoryMock({ renewOccupation: jest.fn().mockReturnValue('forbidden') }),
    );
    const notFound = createService(
      createRepositoryMock({ renewOccupation: jest.fn().mockReturnValue('not_found') }),
    );
    const notOccupied = createService(
      createRepositoryMock({ renewOccupation: jest.fn().mockReturnValue('not_occupied') }),
    );

    expect(() => forbidden.renewOccupation('udid-1', 'wrong')).toThrow(ForbiddenException);
    expect(() => notFound.renewOccupation('x', 'o')).toThrow(NotFoundException);
    expect(() => notOccupied.renewOccupation('udid-1', 'o')).toThrow(ConflictException);
  });

  test('renewOccupation 성공 시 기기 반환 + nowIso로 위임', () => {
    const renewOccupation = jest.fn().mockReturnValue('renewed');
    const service = createService(createRepositoryMock({ renewOccupation }));

    const device = service.renewOccupation('udid-1', 'occupant-1');

    expect(device).toEqual(sampleDevice);
    expect(renewOccupation).toHaveBeenCalledWith('udid-1', 'occupant-1', expect.any(String));
  });

  test('expireIdleOccupations는 (now - TTL) cutoff로 위임', () => {
    const expireIdleOccupations = jest.fn().mockReturnValue(['udid-1']);
    const service = createService(createRepositoryMock({ expireIdleOccupations }));
    const before = Date.now();

    const expiredIds = service.expireIdleOccupations();

    expect(expiredIds).toEqual(['udid-1']);
    const cutoff = new Date(expireIdleOccupations.mock.calls[0][0] as string).getTime();
    expect(cutoff).toBeLessThan(before);
  });

  test('NEBULA_OCCUPATION_TTL_MS 설정 시 cutoff가 그 값 기준으로 계산됨', () => {
    const expireIdleOccupations = jest.fn().mockReturnValue([]);
    const ttlMs = 120_000;
    const service = createService(createRepositoryMock({ expireIdleOccupations }), {
      NEBULA_OCCUPATION_TTL_MS: String(ttlMs),
    });
    const before = Date.now();

    service.expireIdleOccupations();

    const cutoff = new Date(expireIdleOccupations.mock.calls[0][0] as string).getTime();
    const after = Date.now();
    expect(cutoff).toBeGreaterThanOrEqual(before - ttlMs);
    expect(cutoff).toBeLessThanOrEqual(after - ttlMs);
  });

  test('occupationExpiresAt: 활동 시각 + TTL, 미점유면 null', () => {
    const service = createService(createRepositoryMock(), {
      NEBULA_OCCUPATION_TTL_MS: '60000',
    });
    const active: Device = { ...sampleDevice, lastActivityAt: '2026-09-04T00:00:00.000Z' };

    expect(service.occupationExpiresAt(active)).toBe('2026-09-04T00:01:00.000Z');
    expect(service.occupationExpiresAt(sampleDevice)).toBeNull();
  });
});
