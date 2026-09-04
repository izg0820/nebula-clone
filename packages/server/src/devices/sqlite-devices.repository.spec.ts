import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../storage/database.service';
import { RegisterDeviceInput } from './device.types';
import { SqliteDevicesRepository } from './sqlite-devices.repository';

/** 인메모리 SQLite로 저장소 동작 검증 */
describe('SqliteDevicesRepository', () => {
  let databaseService: DatabaseService;
  let repository: SqliteDevicesRepository;

  const NOW = '2026-09-04T00:00:00.000Z';
  const AGENT_ID = 'agent-1';

  const iphone: RegisterDeviceInput = {
    id: 'udid-iphone-1',
    name: 'iPhone 13',
    platform: 'ios',
    osVersion: '17.5',
    tags: ['smoke'],
  };

  beforeEach(() => {
    // Arrange: 인메모리 DB
    const config = { get: () => ':memory:' } as unknown as ConfigService;
    databaseService = new DatabaseService(config);
    repository = new SqliteDevicesRepository(databaseService);
  });

  afterEach(() => {
    databaseService.onApplicationShutdown();
  });

  test('upsertMany는 기기를 online 상태로 등록', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    const devices = repository.findAll();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: iphone.id,
      status: 'online',
      agentId: AGENT_ID,
      occupantId: null,
    });
  });

  test('upsertMany는 기존 기기를 갱신 (중복 생성 안 함)', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.upsertMany([{ ...iphone, name: '변경된 이름' }], AGENT_ID, NOW);

    const devices = repository.findAll();
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe('변경된 이름');
  });

  test('tryOccupy는 미점유 online 기기를 점유', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    const device = repository.tryOccupy({}, 'occupant-1', NOW);

    expect(device?.occupantId).toBe('occupant-1');
    expect(device?.occupiedAt).toBe(NOW);
  });

  test('tryOccupy는 이미 점유된 기기를 재점유하지 않음', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);

    const second = repository.tryOccupy({}, 'occupant-2', NOW);

    expect(second).toBeNull();
  });

  test('tryOccupy는 요청 태그를 모두 가진 기기만 선택', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    expect(repository.tryOccupy({ tags: ['smoke', 'e2e'] }, 'o1', NOW)).toBeNull();
    expect(repository.tryOccupy({ tags: ['smoke'] }, 'o2', NOW)).not.toBeNull();
  });

  test('tryOccupy는 offline 기기를 제외', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.markAgentOffline(AGENT_ID);

    expect(repository.tryOccupy({}, 'occupant-1', NOW)).toBeNull();
  });

  test('release는 occupantId 일치 시에만 해제', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);

    expect(repository.release(iphone.id, 'wrong')).toBe('forbidden');
    expect(repository.release(iphone.id, 'occupant-1')).toBe('released');
    expect(repository.findById(iphone.id)?.occupantId).toBeNull();
  });

  test('release는 미점유·미존재 기기를 구분', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    expect(repository.release('없는-기기', 'o1')).toBe('not_found');
    expect(repository.release(iphone.id, 'o1')).toBe('not_occupied');
  });

  test('heartbeat은 소속 Agent 기기만 갱신', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    const LATER = '2026-09-04T00:01:00.000Z';

    repository.heartbeat([iphone.id], '다른-agent', LATER);
    expect(repository.findById(iphone.id)?.lastHeartbeatAt).toBe(NOW);

    repository.heartbeat([iphone.id], AGENT_ID, LATER);
    expect(repository.findById(iphone.id)?.lastHeartbeatAt).toBe(LATER);
  });

  test('markStaleOffline은 cutoff 이전 하트비트 기기를 오프라인 처리', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    const CUTOFF_AFTER_NOW = '2026-09-04T00:02:00.000Z';

    const staleIds = repository.markStaleOffline(CUTOFF_AFTER_NOW);

    expect(staleIds).toEqual([iphone.id]);
    expect(repository.findById(iphone.id)?.status).toBe('offline');
  });

  test('markAgentOffline은 점유도 함께 해제 (영구 점유 방지)', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);

    repository.markAgentOffline(AGENT_ID);
    // Agent 복귀 시나리오 — 재등록 후 다시 점유 가능해야 함
    repository.upsertMany([iphone], AGENT_ID, NOW);

    const device = repository.findById(iphone.id);
    expect(device?.occupantId).toBeNull();
    expect(repository.tryOccupy({}, 'occupant-2', NOW)).not.toBeNull();
  });

  test('markStaleOffline도 점유를 함께 해제', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    const CUTOFF_AFTER_NOW = '2026-09-04T00:02:00.000Z';

    repository.markStaleOffline(CUTOFF_AFTER_NOW);

    expect(repository.findById(iphone.id)?.occupantId).toBeNull();
  });

  test('markStaleOffline은 최신 하트비트 기기를 건드리지 않음', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    const CUTOFF_BEFORE_NOW = '2026-09-03T23:00:00.000Z';

    expect(repository.markStaleOffline(CUTOFF_BEFORE_NOW)).toEqual([]);
    expect(repository.findById(iphone.id)?.status).toBe('online');
  });
});
