import Database from 'better-sqlite3';
import { ensureDeviceColumns } from './database.service';

/** 구 스키마(last_activity_at 없음) — 기존 nebula.sqlite 파일 재현 */
const LEGACY_SCHEMA = `
  CREATE TABLE devices (
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
`;

function columnNames(db: Database.Database): string[] {
  const rows = db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('ensureDeviceColumns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('구 스키마에 last_activity_at 컬럼을 추가하고 점유 행을 occupied_at으로 백필', () => {
    db.exec(LEGACY_SCHEMA);
    db.exec(`
      INSERT INTO devices (id, name, platform, os_version, occupant_id, occupied_at)
      VALUES ('occupied', 'iPhone', 'ios', '26.0', 'occupant-1', '2026-09-01T00:00:00.000Z'),
             ('free', 'iPhone 2', 'ios', '26.0', NULL, NULL)
    `);

    ensureDeviceColumns(db);

    expect(columnNames(db)).toContain('last_activity_at');
    const occupied = db
      .prepare('SELECT last_activity_at FROM devices WHERE id = ?')
      .get('occupied') as { last_activity_at: string | null };
    const free = db.prepare('SELECT last_activity_at FROM devices WHERE id = ?').get('free') as {
      last_activity_at: string | null;
    };
    expect(occupied.last_activity_at).toBe('2026-09-01T00:00:00.000Z');
    expect(free.last_activity_at).toBeNull();
  });

  test('멱등 — 두 번 실행해도 오류 없이 기존 값 보존', () => {
    db.exec(LEGACY_SCHEMA);
    ensureDeviceColumns(db);
    db.prepare(
      `INSERT INTO devices (id, name, platform, os_version, occupant_id, last_activity_at)
       VALUES ('d1', 'iPhone', 'ios', '26.0', 'o1', '2026-09-02T00:00:00.000Z')`,
    ).run();

    expect(() => ensureDeviceColumns(db)).not.toThrow();

    const row = db.prepare('SELECT last_activity_at FROM devices WHERE id = ?').get('d1') as {
      last_activity_at: string;
    };
    expect(row.last_activity_at).toBe('2026-09-02T00:00:00.000Z');
  });
});
