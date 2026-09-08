import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileSessionStore, StoredOccupation } from './session-store';

const OCCUPATION: StoredOccupation = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'udid-1',
  occupantId: 'occ-secret',
  occupiedAt: '2026-09-08T00:00:00.000Z',
};

describe('FileSessionStore', () => {
  let dir: string;
  let filePath: string;
  let store: FileSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nebula-session-'));
    filePath = join(dir, 'session.json');
    store = new FileSessionStore(filePath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileMode(): number {
    return statSync(filePath).mode & 0o777;
  }

  test('save는 0600으로 기록하고 load로 복원됨', () => {
    store.save(OCCUPATION);

    expect(fileMode()).toBe(0o600);
    expect(store.load()).toEqual(OCCUPATION);
  });

  test('기존 파일이 넉넉한 권한이어도 save가 0600으로 강제 (occupantId는 비밀값)', () => {
    writeFileSync(filePath, '{}');
    chmodSync(filePath, 0o644);

    store.save(OCCUPATION);

    expect(fileMode()).toBe(0o600);
  });

  test('손상·형식 불일치 파일은 세션 없음으로 처리', () => {
    writeFileSync(filePath, 'not-json');
    expect(store.load()).toBeNull();

    writeFileSync(filePath, JSON.stringify({ deviceId: 'x' }));
    expect(store.load()).toBeNull();
  });

  test('clear는 파일 제거 — 없는 파일에도 무해', () => {
    store.save(OCCUPATION);
    store.clear();
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});
