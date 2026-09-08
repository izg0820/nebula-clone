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

  test('tryOccupy는 deviceId 지정 시 해당 기기만 점유', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    expect(repository.tryOccupy({ deviceId: '다른-기기' }, 'o1', NOW)).toBeNull();
    expect(repository.tryOccupy({ deviceId: iphone.id }, 'o2', NOW)?.id).toBe(iphone.id);
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

  test('markAgentOffline은 점유를 유지 (터널 블립 유예) — 재연결 시 세션 이어짐', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);

    repository.markAgentOffline(AGENT_ID);
    expect(repository.findById(iphone.id)?.status).toBe('offline');
    expect(repository.findById(iphone.id)?.occupantId).toBe('occupant-1');

    // Agent 복귀 — 점유가 그대로 살아 있어야 함
    repository.upsertMany([iphone], AGENT_ID, NOW);
    expect(repository.findById(iphone.id)?.occupantId).toBe('occupant-1');
    expect(repository.tryOccupy({}, 'occupant-2', NOW)).toBeNull();
  });

  test('markStaleOffline도 점유를 함께 해제', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    const CUTOFF_AFTER_NOW = '2026-09-04T00:02:00.000Z';

    repository.markStaleOffline(CUTOFF_AFTER_NOW);

    expect(repository.findById(iphone.id)?.occupantId).toBeNull();
  });

  test('markStaleOffline은 offline+점유 잔존 기기도 회수 (Agent 미복귀 영구 점유 방지)', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    repository.markAgentOffline(AGENT_ID);
    const CUTOFF_AFTER_NOW = '2026-09-04T00:02:00.000Z';

    const staleIds = repository.markStaleOffline(CUTOFF_AFTER_NOW);

    expect(staleIds).toEqual([iphone.id]);
    expect(repository.findById(iphone.id)?.occupantId).toBeNull();
  });

  test('markStaleOffline은 최신 하트비트 기기를 건드리지 않음', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    const CUTOFF_BEFORE_NOW = '2026-09-03T23:00:00.000Z';

    expect(repository.markStaleOffline(CUTOFF_BEFORE_NOW)).toEqual([]);
    expect(repository.findById(iphone.id)?.status).toBe('online');
  });

  test('tryOccupy는 lastActivityAt을 점유 시각으로 초기화', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    const device = repository.tryOccupy({}, 'occupant-1', NOW);

    expect(device?.lastActivityAt).toBe(NOW);
  });

  test('renewOccupation은 occupantId 일치 시에만 활동 시각 갱신', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    const LATER = '2026-09-04T00:05:00.000Z';

    expect(repository.renewOccupation(iphone.id, 'wrong', LATER)).toBe('forbidden');
    expect(repository.findById(iphone.id)?.lastActivityAt).toBe(NOW);

    expect(repository.renewOccupation(iphone.id, 'occupant-1', LATER)).toBe('renewed');
    expect(repository.findById(iphone.id)?.lastActivityAt).toBe(LATER);
  });

  test('renewOccupation은 미점유·미존재 기기를 구분', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);

    expect(repository.renewOccupation('없는-기기', 'o1', NOW)).toBe('not_found');
    expect(repository.renewOccupation(iphone.id, 'o1', NOW)).toBe('not_occupied');
  });

  test('renewOccupation은 offline 기기도 연장 가능 (터널 블립 중 점유 유지)', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    repository.markAgentOffline(AGENT_ID);
    const LATER = '2026-09-04T00:05:00.000Z';

    expect(repository.renewOccupation(iphone.id, 'occupant-1', LATER)).toBe('renewed');
    expect(repository.findById(iphone.id)?.lastActivityAt).toBe(LATER);
  });

  test('expireIdleOccupations는 유휴 점유만 회수하고 status·agentId는 유지', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    const CUTOFF_AFTER_NOW = '2026-09-04T00:11:00.000Z';

    const expiredIds = repository.expireIdleOccupations(CUTOFF_AFTER_NOW);

    expect(expiredIds).toEqual([iphone.id]);
    const device = repository.findById(iphone.id);
    expect(device?.occupantId).toBeNull();
    expect(device?.occupiedAt).toBeNull();
    expect(device?.lastActivityAt).toBeNull();
    expect(device?.status).toBe('online');
    expect(device?.agentId).toBe(AGENT_ID);
  });

  test('expireIdleOccupations는 cutoff 이후 활동한 점유를 건드리지 않음', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    repository.renewOccupation(iphone.id, 'occupant-1', '2026-09-04T00:10:00.000Z');
    const CUTOFF_BETWEEN = '2026-09-04T00:05:00.000Z';

    expect(repository.expireIdleOccupations(CUTOFF_BETWEEN)).toEqual([]);
    expect(repository.findById(iphone.id)?.occupantId).toBe('occupant-1');
  });

  test('expireIdleOccupations는 활동 시각 없는 점유(알 수 없는 상태)를 회수', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    // 수동 DB 조작 등으로 활동 시각만 소실된 상태 재현
    databaseService.connection
      .prepare('UPDATE devices SET last_activity_at = NULL WHERE id = ?')
      .run(iphone.id);

    expect(repository.expireIdleOccupations('2026-09-03T00:00:00.000Z')).toEqual([iphone.id]);
  });

  test('만료 회수 직후 같은 기기를 즉시 재점유 가능', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    repository.expireIdleOccupations('2026-09-04T00:11:00.000Z');

    const reoccupied = repository.tryOccupy({}, 'occupant-2', '2026-09-04T00:12:00.000Z');

    expect(reoccupied?.occupantId).toBe('occupant-2');
  });

  test('release·markStaleOffline은 lastActivityAt도 NULL로 되돌림 (동시 설정/해제 불변식)', () => {
    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-1', NOW);
    repository.release(iphone.id, 'occupant-1');
    expect(repository.findById(iphone.id)?.lastActivityAt).toBeNull();

    repository.upsertMany([iphone], AGENT_ID, NOW);
    repository.tryOccupy({}, 'occupant-2', NOW);
    repository.markStaleOffline('2026-09-04T00:02:00.000Z');
    expect(repository.findById(iphone.id)?.lastActivityAt).toBeNull();
  });
});
