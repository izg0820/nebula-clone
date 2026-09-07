import { spawn } from 'child_process';
import { mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { ControllerEndpointResolver } from './controller-registry';
import { logger } from './logger';

/** 헬스 폴링 주기·판정 */
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_FAIL_THRESHOLD = 3;
const HEALTH_TIMEOUT_MS = 5_000;

/** 재기동 백오프 */
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;

/** SIGTERM 후 이 시간 내 미종료 시 SIGKILL 에스컬레이션 */
const KILL_ESCALATION_MS = 3_000;

/** 수퍼바이저 설정 */
export interface SupervisorConfig {
  /** NebulaController.xcodeproj 경로 */
  readonly projectPath: string;
  readonly scheme: string;
  /** 맥 로컬 포워딩 포트 시작값 — 기기마다 순차 할당 (해제 시 재사용) */
  readonly basePort: number;
  /** 기기별 DerivedData 루트 — 동시 xcodebuild의 빌드 DB 경합 방지 */
  readonly derivedDataDir: string;
  /** 기기별 xcodebuild 로그 디렉터리 — 실패 원인 진단용 */
  readonly logDir: string;
}

/** 자식 프로세스 최소 인터페이스 (테스트 주입용) */
export interface ChildLike {
  readonly pid?: number;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 외부 의존 주입 지점 — 테스트에서 가짜로 대체 */
export interface SupervisorDeps {
  readonly spawnProcess: (command: string, args: readonly string[], logPath: string) => ChildLike;
  readonly checkHealth: (baseUrl: string) => Promise<boolean>;
}

/** 종료 추적 가능한 자식 프로세스 래퍼 */
interface TrackedProcess {
  readonly child: ChildLike;
  hasExited: boolean;
}

/** 기기별 Controller 세션 상태 */
interface Session {
  readonly deviceId: string;
  readonly port: number;
  runner: TrackedProcess | null;
  proxy: TrackedProcess | null;
  isReady: boolean;
  healthFailCount: number;
  restartAttempt: number;
  healthTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  isStopping: boolean;
  /** 재기동 세대 — 옛 세대의 늦은 exit·헬스 응답이 새 세션을 건드리지 않도록 */
  generation: number;
}

/** stdout·stderr를 로그 파일에 append — 서명 만료·빌드 실패 진단 근거 확보 */
function defaultSpawn(command: string, args: readonly string[], logPath: string): ChildLike {
  const fd = openSync(logPath, 'a');
  // detached: 프로세스 그룹 리더로 만들어 그룹 단위 종료 가능하게
  return spawn(command, [...args], { stdio: ['ignore', fd, fd], detached: true });
}

async function defaultCheckHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'POST',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 프로세스 그룹에 시그널 전송 — pid 없거나 그룹 전송 실패 시 단일 프로세스로 폴백 */
function signalProcessTree(tracked: TrackedProcess, signal: NodeJS.Signals): void {
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

/**
 * Controller 프로세스 오케스트레이션 — 기기별 xcodebuild 러너 + iproxy 자동 기동·감시·재기동
 * - syncDevices: 발견된 기기 집합에 맞춰 세션 시작/정리
 * - 헬스 폴링 연속 실패, 자식 프로세스 종료·spawn 실패 → 백오프 재기동
 * - 종료는 프로세스 그룹 SIGTERM → 3초 내 미종료 시 SIGKILL
 * - 사전 조건: codesign 키체인 "항상 허용" 1회, 기기 개발자 모드·신뢰 완료 (controller-ios/README.md)
 */
export class ControllerSupervisor implements ControllerEndpointResolver {
  private readonly sessions = new Map<string, Session>();
  private nextPortOffset = 0;
  /** 정리된 세션의 반납 포트 — 단조 증가로 인한 포트 고갈 방지 */
  private readonly freePorts: number[] = [];
  private readonly deps: SupervisorDeps;

  constructor(
    private readonly config: SupervisorConfig,
    deps: Partial<SupervisorDeps> = {},
  ) {
    this.deps = {
      spawnProcess: deps.spawnProcess ?? defaultSpawn,
      checkHealth: deps.checkHealth ?? defaultCheckHealth,
    };
  }

  /** 발견된 기기 집합과 세션 동기화 — 새 기기는 시작, 사라진 기기는 정리 */
  syncDevices(deviceIds: readonly string[]): void {
    const current = new Set(deviceIds);
    for (const deviceId of current) {
      if (!this.sessions.has(deviceId)) this.startSession(deviceId);
    }
    for (const deviceId of this.sessions.keys()) {
      if (!current.has(deviceId)) this.stopSession(deviceId);
    }
  }

  resolve(deviceId: string): string | null {
    const session = this.sessions.get(deviceId);
    if (!session) return null;
    return `http://127.0.0.1:${session.port}`;
  }

  isReady(deviceId: string): boolean {
    return this.sessions.get(deviceId)?.isReady ?? false;
  }

  stopAll(): void {
    for (const deviceId of [...this.sessions.keys()]) this.stopSession(deviceId);
  }

  private allocatePort(): number {
    const reused = this.freePorts.shift();
    if (reused !== undefined) return reused;
    const port = this.config.basePort + this.nextPortOffset;
    this.nextPortOffset += 1;
    return port;
  }

  private startSession(deviceId: string): void {
    const session: Session = {
      deviceId,
      port: this.allocatePort(),
      runner: null,
      proxy: null,
      isReady: false,
      healthFailCount: 0,
      restartAttempt: 0,
      healthTimer: null,
      restartTimer: null,
      isStopping: false,
      generation: 0,
    };
    this.sessions.set(deviceId, session);
    logger.info({ deviceId, port: session.port }, 'Controller 세션 시작');

    try {
      mkdirSync(this.config.logDir, { recursive: true });
    } catch (error) {
      logger.warn({ err: error }, '로그 디렉터리 생성 실패 — 진단 로그 없이 진행');
    }
    this.launchProcesses(session);
  }

  private launchProcesses(session: Session): void {
    session.isReady = false;
    session.healthFailCount = 0;
    session.generation += 1;
    const generation = session.generation;
    const logPath = join(this.config.logDir, `controller-${session.deviceId}.log`);

    session.runner = this.track(
      session, generation, 'xcodebuild',
      ['test',
        '-project', this.config.projectPath,
        '-scheme', this.config.scheme,
        '-destination', `id=${session.deviceId}`,
        '-derivedDataPath', join(this.config.derivedDataDir, session.deviceId),
        '-allowProvisioningUpdates'],
      logPath,
    );
    session.proxy = this.track(
      session, generation, 'iproxy',
      [String(session.port), '8100', '-u', session.deviceId],
      logPath,
    );

    session.healthTimer = setInterval(
      () => void this.pollHealth(session, generation),
      HEALTH_INTERVAL_MS,
    );
  }

  /** 프로세스 기동 + exit/error 추적 — spawn 실패(ENOENT)도 재기동 경로로 수렴 */
  private track(
    session: Session,
    generation: number,
    command: string,
    args: readonly string[],
    logPath: string,
  ): TrackedProcess {
    const child = this.deps.spawnProcess(command, args, logPath);
    const tracked: TrackedProcess = { child, hasExited: false };

    child.on('exit', (code: number | null) => {
      tracked.hasExited = true;
      this.handleChildFailure(session, generation, command, `exit code=${code}`);
    });
    child.on('error', (error: Error) => {
      // ENOENT 등 — exit 이벤트 없이 error만 방출됨. 미처리 시 Agent 전체가 죽음
      tracked.hasExited = true;
      this.handleChildFailure(session, generation, command, `spawn 실패: ${error.message}`);
    });
    return tracked;
  }

  private async pollHealth(session: Session, generation: number): Promise<void> {
    const baseUrl = `http://127.0.0.1:${session.port}`;
    const isHealthy = await this.deps.checkHealth(baseUrl);

    // await 사이에 teardown·재기동이 일어났으면 이 결과는 옛 것 — 폐기
    // (runner null = 백오프 대기 중: 세대 번호는 재기동 시점에만 증가하므로 별도 확인 필수)
    if (session.isStopping || session.generation !== generation || session.runner === null) return;

    if (isHealthy) {
      if (!session.isReady) {
        logger.info({ deviceId: session.deviceId }, 'Controller 준비됨');
      }
      session.isReady = true;
      session.healthFailCount = 0;
      session.restartAttempt = 0;
      return;
    }

    session.healthFailCount += 1;
    // 준비 전(빌드 중)에는 실패가 정상 — 준비된 후의 연속 실패만 재기동 사유
    if (!session.isReady) return;
    if (session.healthFailCount < HEALTH_FAIL_THRESHOLD) return;

    logger.warn(
      { deviceId: session.deviceId, failCount: session.healthFailCount },
      'Controller 헬스 연속 실패 — 재기동',
    );
    this.scheduleRestart(session);
  }

  private handleChildFailure(
    session: Session,
    generation: number,
    processName: string,
    reason: string,
  ): void {
    if (session.isStopping || session.generation !== generation) return;
    logger.warn({ deviceId: session.deviceId, process: processName, reason }, 'Controller 프로세스 이상');
    this.scheduleRestart(session);
  }

  private scheduleRestart(session: Session): void {
    if (session.isStopping || session.restartTimer) return;
    this.teardownProcesses(session);

    const delay = Math.min(RESTART_BASE_MS * 2 ** session.restartAttempt, RESTART_MAX_MS);
    session.restartAttempt += 1;
    logger.info({ deviceId: session.deviceId, delay, attempt: session.restartAttempt }, '재기동 예약');

    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      if (session.isStopping) return;
      this.launchProcesses(session);
    }, delay);
  }

  private stopSession(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    session.isStopping = true;
    if (session.restartTimer) clearTimeout(session.restartTimer);
    this.teardownProcesses(session);
    this.sessions.delete(deviceId);
    this.freePorts.push(session.port);
    logger.info({ deviceId }, 'Controller 세션 정리');
  }

  /** 프로세스 그룹 SIGTERM → 유예 후 SIGKILL 에스컬레이션 */
  private teardownProcesses(session: Session): void {
    if (session.healthTimer) {
      clearInterval(session.healthTimer);
      session.healthTimer = null;
    }
    session.isReady = false;

    for (const tracked of [session.runner, session.proxy]) {
      if (!tracked) continue;
      signalProcessTree(tracked, 'SIGTERM');
      const escalation = setTimeout(() => {
        if (tracked.hasExited) return;
        logger.warn('SIGTERM 미응답 — SIGKILL 에스컬레이션');
        signalProcessTree(tracked, 'SIGKILL');
      }, KILL_ESCALATION_MS);
      escalation.unref();
    }
    session.runner = null;
    session.proxy = null;
  }
}
