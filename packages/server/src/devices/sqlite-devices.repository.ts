import { Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../storage/database.service';
import {
  Device,
  DevicePlatform,
  DeviceStatus,
  OccupyFilter,
  RegisterDeviceInput,
  ReleaseResult,
} from './device.types';
import { DevicesRepository } from './devices.repository';

/** devices 테이블 row 형태 */
interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  os_version: string;
  tags: string;
  status: string;
  agent_id: string | null;
  occupant_id: string | null;
  occupied_at: string | null;
  last_heartbeat_at: string | null;
}

/** row → 도메인 객체 변환 */
function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as DevicePlatform,
    osVersion: row.os_version,
    tags: JSON.parse(row.tags) as string[],
    status: row.status as DeviceStatus,
    agentId: row.agent_id,
    occupantId: row.occupant_id,
    occupiedAt: row.occupied_at,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

/** 요청 태그가 기기 태그에 모두 포함되는지 확인 */
function hasAllTags(deviceTags: readonly string[], requiredTags: readonly string[]): boolean {
  return requiredTags.every((tag) => deviceTags.includes(tag));
}

/**
 * SQLite 기반 레지스트리 구현
 * better-sqlite3는 동기 단일 커넥션 — 트랜잭션 내 조회+갱신이 원자적
 */
@Injectable()
export class SqliteDevicesRepository implements DevicesRepository {
  private readonly db: Database.Database;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.connection;
  }

  upsertMany(devices: readonly RegisterDeviceInput[], agentId: string, nowIso: string): void {
    const upsert = this.db.prepare(`
      INSERT INTO devices (id, name, platform, os_version, tags, status, agent_id, last_heartbeat_at)
      VALUES (@id, @name, @platform, @osVersion, @tags, 'online', @agentId, @nowIso)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        platform = @platform,
        os_version = @osVersion,
        tags = @tags,
        status = 'online',
        agent_id = @agentId,
        last_heartbeat_at = @nowIso
    `);
    const runAll = this.db.transaction((items: readonly RegisterDeviceInput[]) => {
      for (const item of items) {
        upsert.run({
          id: item.id,
          name: item.name,
          platform: item.platform,
          osVersion: item.osVersion,
          tags: JSON.stringify(item.tags),
          agentId,
          nowIso,
        });
      }
    });
    runAll(devices);
  }

  findAll(): Device[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY name').all() as DeviceRow[];
    return rows.map(toDevice);
  }

  findById(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      | DeviceRow
      | undefined;
    if (!row) return null;
    return toDevice(row);
  }

  tryOccupy(filter: OccupyFilter, occupantId: string, nowIso: string): Device | null {
    const occupy = this.db.transaction((): Device | null => {
      const rows = this.db
        .prepare(`SELECT * FROM devices WHERE status = 'online' AND occupant_id IS NULL`)
        .all() as DeviceRow[];

      const candidate = rows
        .map(toDevice)
        .find(
          (device) =>
            (!filter.deviceId || device.id === filter.deviceId) &&
            (!filter.platform || device.platform === filter.platform) &&
            hasAllTags(device.tags, filter.tags ?? []),
        );
      if (!candidate) return null;

      // 트랜잭션 내부라 candidate 조회 후 갱신까지 원자적
      const result = this.db
        .prepare(
          `UPDATE devices SET occupant_id = ?, occupied_at = ?
           WHERE id = ? AND occupant_id IS NULL AND status = 'online'`,
        )
        .run(occupantId, nowIso, candidate.id);
      if (result.changes !== 1) return null;

      return this.findById(candidate.id);
    });
    return occupy();
  }

  release(deviceId: string, occupantId: string): ReleaseResult {
    const releaseTx = this.db.transaction((): ReleaseResult => {
      const device = this.findById(deviceId);
      if (!device) return 'not_found';
      if (!device.occupantId) return 'not_occupied';
      if (device.occupantId !== occupantId) return 'forbidden';

      this.db
        .prepare('UPDATE devices SET occupant_id = NULL, occupied_at = NULL WHERE id = ?')
        .run(deviceId);
      return 'released';
    });
    return releaseTx();
  }

  heartbeat(deviceIds: readonly string[], agentId: string, nowIso: string): void {
    const update = this.db.prepare(
      `UPDATE devices SET last_heartbeat_at = ?, status = 'online' WHERE id = ? AND agent_id = ?`,
    );
    const runAll = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) update.run(nowIso, id, agentId);
    });
    runAll(deviceIds);
  }

  markAgentOffline(agentId: string): void {
    // 점유는 유지 — 터널이 수 초 끊겼다 재연결되는 블립에 사용자 세션이 강제 종료되지 않게.
    // 점유 해제는 하트비트 만료 스윕(markStaleOffline)에서만 (유예 = HEARTBEAT_TIMEOUT_MS)
    this.db
      .prepare(
        `UPDATE devices
         SET status = 'offline', agent_id = NULL
         WHERE agent_id = ?`,
      )
      .run(agentId);
  }

  markStaleOffline(cutoffIso: string): string[] {
    const stale = this.db.transaction((): string[] => {
      // offline이지만 점유가 남은 기기도 포함 — markAgentOffline이 점유를 유지하므로
      // 여기서 회수하지 않으면 Agent 미복귀 시 영구 점유가 됨
      const rows = this.db
        .prepare(
          `SELECT id FROM devices
           WHERE (status = 'online' OR occupant_id IS NOT NULL)
             AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
        )
        .all(cutoffIso) as Array<{ id: string }>;
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      const markOffline = this.db.prepare(
        `UPDATE devices
         SET status = 'offline', occupant_id = NULL, occupied_at = NULL
         WHERE id = ?`,
      );
      for (const id of ids) markOffline.run(id);
      return ids;
    });
    return stale();
  }
}
