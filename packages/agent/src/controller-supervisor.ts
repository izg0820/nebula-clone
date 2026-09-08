import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, statSync } from 'fs';
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

/** 반납 포트 재사용 쿨다운 — 옛 iproxy가 bind를 놓기 전 새 세션이 같은 포트를 잡는 경합 방지 */
const PORT_COOLDOWN_MS = 5_000;

/**
 * 기동 후 이 시간 내 준비(첫 헬스 성공) 실패 시 강제 재기동 — xcodebuild가
 * 키체인 프롬프트 등으로 행하면 "영원히 not-ready·로그 없음"으로 남는 것 방지
 */
const READY_DEADLINE_MS = 10 * 60_000;

/** xcodebuild 로그 파일 상한 — 재기동 루프에서 디스크 압박 방지 (초과 시 truncate) */
const LOG_MAX_BYTES = 10 * 1024 * 1024;

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
  /** Controller 토큰 — 설정 시 러너 env(TEST_RUNNER_...)로 주입 + 헬스체크 헤더 첨부 */
  readonly controllerToken?: string | null;
  /** 러너 헬스 폴링 주기 (ms) — 미지정 시 기본 10초 */
  readonly healthIntervalMs?: number;
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
  /** 현 세대 기동 시각 — 준비 데드라인 판정용 */
  launchedAtMs: number;
}

/** 로그 파일 fd 확보 — 상한 초과 시 truncate(회전), 실패(디렉터리 없음·EMFILE 등) 시 로그 없이 진행 */
function openLogFd(logPath: string): number | null {
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

function toStdio(fd: number | null): ('ignore' | number)[] {
  if (fd === null) return ['ignore', 'ignore', 'ignore'];
  return ['ignore', fd, fd];
}

/** TEST_RUNNER_ 접두사 env는 xcodebuild가 러너 프로세스 환경으로 전달함 — 토큰 배선 */
function toRunnerEnv(controllerToken: string | null): NodeJS.ProcessEnv {
  if (!controllerToken) return process.env;
  return { ...process.env, TEST_RUNNER_NEBULA_CONTROLLER_TOKEN: controllerToken };
}

function toTokenHeaders(controllerToken: string | null): Record<string, string> {
  if (!controllerToken) return {};
  return { 'x-nebula-token': controllerToken };
}

/** stdout·stderr를 로그 파일에 append — 서명 만료·빌드 실패 진단 근거 확보 */
function makeDefaultSpawn(controllerToken: string | null): SupervisorDeps['spawnProcess'] {
  const env = toRunnerEnv(controllerToken);
  return (command, args, logPath) => {
    const fd = openLogFd(logPath);
    // detached: 프로세스 그룹 리더로 만들어 그룹 단위 종료 가능하게
    const child = spawn(command, [...args], { stdio: toStdio(fd), detached: true, env });
    // spawn이 fd를 자식에 dup하므로 부모 사본은 즉시 닫음 — 재기동 루프에서 fd 누수 방지
    if (fd !== null) closeSync(fd);
    return child;
  };
}

function makeDefaultCheckHealth(controllerToken: string | null): SupervisorDeps['checkHealth'] {
  const headers = toTokenHeaders(controllerToken);
  return async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
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
  /** 종료 신호를 보냈지만 아직 exit 확인이 안 된 프로세스 — awaitTermination 대기 대상 */
  private terminating: TrackedProcess[] = [];
  private readonly deps: SupervisorDeps;

  constructor(
    private readonly config: SupervisorConfig,
    deps: Partial<SupervisorDeps> = {},
  ) {
    const controllerToken = config.controllerToken ?? null;
    this.deps = {
      spawnProcess: deps.spawnProcess ?? makeDefaultSpawn(controllerToken),
      checkHealth: deps.checkHealth ?? makeDefaultCheckHealth(controllerToken),
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

  /**
   * 종료 신호를 보낸 프로세스들의 실제 종료 대기 — 상한 초과 시 SIGKILL 후 반환.
   * shutdown 경로에서 process.exit 전에 호출해야 detached 자식(xcodebuild·iproxy)이
   * 고아로 남아 포트를 점유하는 것을 막음 (unref된 에스컬레이션 타이머는 exit 시 실행 안 됨)
   */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      this.terminating = this.terminating.filter((tracked) => !tracked.hasExited);
      if (this.terminating.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const tracked of this.terminating) {
      logger.warn('종료 유예 초과 — SIGKILL');
      signalProcessTree(tracked, 'SIGKILL');
    }
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
      launchedAtMs: Date.now(),
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
    session.launchedAtMs = Date.now();
    const generation = session.generation;
    const logPath = join(this.config.logDir, `controller-${session.deviceId}.log`);

    // spawn 자체의 동기 예외(EMFILE 등)도 백오프 재기동으로 수렴 — 미보호 시
    // startSession 경로는 세션이 영구 wedge, restartTimer 경로는 uncaughtException으로 데몬 사망
    try {
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
    } catch (error) {
      logger.error({ err: error, deviceId: session.deviceId }, 'Controller 프로세스 기동 실패');
      this.scheduleRestart(session);
      return;
    }

    session.healthTimer = setInterval(
      () => void this.pollHealth(session, generation),
      this.config.healthIntervalMs ?? HEALTH_INTERVAL_MS,
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
    // 준비 전(빌드 중)에는 실패가 정상 — 단, 데드라인 초과는 행(키체인 프롬프트 등)으로 보고 재기동
    if (!session.isReady) {
      if (Date.now() - session.launchedAtMs < READY_DEADLINE_MS) return;
      logger.error(
        { deviceId: session.deviceId, deadlineMs: READY_DEADLINE_MS },
        'Controller 준비 데드라인 초과 — 강제 재기동 (xcodebuild 행 의심, 로그 파일 확인)',
      );
      this.scheduleRestart(session);
      return;
    }
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
    // 즉시 반납 금지 — 옛 iproxy가 아직 bind 중일 수 있어 쿨다운 후 재사용
    const cooldown = setTimeout(() => {
      this.freePorts.push(session.port);
    }, PORT_COOLDOWN_MS);
    cooldown.unref();
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
      this.terminating.push(tracked);
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
