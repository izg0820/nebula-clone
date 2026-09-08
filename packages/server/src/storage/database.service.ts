import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { DEFAULT_DB_PATH } from '../config/constants';

/**
 * 기존 DB 파일 호환 마이그레이션 — CREATE TABLE IF NOT EXISTS는 컬럼을 추가하지 않음.
 * 멱등: 기동마다 호출해도 무해. 새 컬럼은 여기에 등록할 것
 */
export function ensureDeviceColumns(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'last_activity_at')) return;
  db.exec('ALTER TABLE devices ADD COLUMN last_activity_at TEXT');
  // 기존 점유 행 백필 — 알려진 유일한 활동 시각은 점유 시작 시각
  db.exec('UPDATE devices SET last_activity_at = occupied_at WHERE occupant_id IS NOT NULL');
}

/** SQLite 커넥션 관리 — 스키마 초기화 및 종료 시 정리 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly db: Database.Database;

  constructor(config: ConfigService) {
    const dbPath = config.get<string>('DB_PATH') ?? DEFAULT_DB_PATH;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    ensureDeviceColumns(this.db);
  }

  get connection(): Database.Database {
    return this.db;
  }

  onApplicationShutdown(): void {
    this.db.close();
  }

  /** devices 테이블 생성 */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        platform          TEXT NOT NULL,
        os_version        TEXT NOT NULL,
        tags              TEXT NOT NULL DEFAULT '[]',
        status            TEXT NOT NULL DEFAULT 'offline',
        agent_id          TEXT,
        occupant_id       TEXT,
        occupied_at       TEXT,
        last_heartbeat_at TEXT,
        last_activity_at  TEXT
      )
    `);
  }
}
