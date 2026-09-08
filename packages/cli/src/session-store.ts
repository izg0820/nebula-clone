import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** 저장된 활성 점유 1건 — 세션리스 아키텍처라 다중 세션 관리는 하지 않음 */
export interface StoredOccupation {
  readonly serverUrl: string;
  readonly deviceId: string;
  readonly occupantId: string;
  readonly occupiedAt: string;
}

export interface SessionStore {
  load(): StoredOccupation | null;
  save(occupation: StoredOccupation): void;
  clear(): void;
}

function isStoredOccupation(value: unknown): value is StoredOccupation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.serverUrl === 'string' &&
    typeof record.deviceId === 'string' &&
    typeof record.occupantId === 'string' &&
    typeof record.occupiedAt === 'string'
  );
}

/** 파일 기반 저장 — occupantId는 해제 권한 비밀값이라 디렉터리 0700 / 파일 0600 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  load(): StoredOccupation | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (!isStoredOccupation(parsed)) return null;
      return parsed;
    } catch {
      // 파일 없음·손상은 세션 없음으로 처리
      return null;
    }
  }

  save(occupation: StoredOccupation): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, `${JSON.stringify(occupation, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync의 mode는 새 파일에만 적용 — 기존 파일이 넉넉한 권한이면 그대로 남으므로 강제
    chmodSync(this.filePath, 0o600);
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}

/** 테스트·주입용 메모리 구현 */
export class MemorySessionStore implements SessionStore {
  private occupation: StoredOccupation | null = null;

  load(): StoredOccupation | null {
    return this.occupation;
  }

  save(occupation: StoredOccupation): void {
    this.occupation = occupation;
  }

  clear(): void {
    this.occupation = null;
  }
}
