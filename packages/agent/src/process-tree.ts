import { closeSync, openSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger';

/** 로그 파일 상한 — 재기동 루프의 디스크 압박 방지 (초과 시 truncate 회전) */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** 자식 프로세스 최소 인터페이스 (테스트 주입용) */
export interface ChildLike {
  readonly pid?: number;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 종료 추적 가능한 자식 프로세스 래퍼 */
export interface TrackedProcess {
  readonly child: ChildLike;
  hasExited: boolean;
}

/** 로그 파일 fd 확보 — 상한 초과 시 truncate(회전), 실패 시 로그 없이 진행 */
export function openLogFd(logPath: string): number | null {
  try {
    const flags = shouldTruncateLog(logPath) ? 'w' : 'a';
    return openSync(logPath, flags);
  } catch (error) {
    logger.warn({ err: error, logPath }, '로그 파일 열기 실패 — 진단 로그 없이 spawn');
    return null;
  }
}

function shouldTruncateLog(logPath: string): boolean {
  try {
    return statSync(logPath).size > LOG_MAX_BYTES;
  } catch {
    return false;
  }
}

export function toStdio(fd: number | null): ('ignore' | number)[] {
  if (fd === null) return ['ignore', 'ignore', 'ignore'];
  return ['ignore', fd, fd];
}

/** stdout·stderr를 로그 파일에 append하는 장수명 프로세스 spawn — 프로세스 그룹 리더로 */
export function spawnLogged(
  command: string,
  args: readonly string[],
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildLike {
  const fd = openLogFd(logPath);
  const child = spawn(command, [...args], { stdio: toStdio(fd), detached: true, env });
  // spawn이 fd를 자식에 dup하므로 부모 사본은 즉시 닫음 — 재기동 루프에서 fd 누수 방지
  if (fd !== null) closeSync(fd);
  return child;
}

/** 프로세스 그룹에 시그널 전송 — pid 없거나 그룹 전송 실패 시 단일 프로세스로 폴백 */
export function signalProcessTree(tracked: TrackedProcess, signal: NodeJS.Signals): void {
  if (tracked.hasExited) return;
  const { child } = tracked;
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
