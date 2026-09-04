import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { DEFAULT_DB_PATH } from '../config/constants';

/** SQLite 커넥션 관리 — 스키마 초기화 및 종료 시 정리 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly db: Database.Database;

  constructor(config: ConfigService) {
    const dbPath = config.get<string>('DB_PATH') ?? DEFAULT_DB_PATH;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
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
        last_heartbeat_at TEXT
      )
    `);
  }
}
