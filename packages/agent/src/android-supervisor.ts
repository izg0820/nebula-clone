import { mkdirSync } from 'fs';
import { join } from 'path';
import { AdbClient } from './adb-client';
import { AndroidRunnerTuning, AndroidSupervisorTuning } from './config';
import { makeControllerHealthCheck } from './controller-health';
import { ControllerEndpointResolver } from './controller-registry';
import { logger } from './logger';
import { ChildLike, signalProcessTree, spawnLogged, TrackedProcess } from './process-tree';

/** 기기측 러너 포트 고정 — 기기마다 adb 네임스페이스가 분리되므로 맥 쪽 포트만 다르게 */
const DEVICE_RUNNER_PORT = 8300;

const RUNNER_COMPONENT = 'com.nebula.controller/.ControllerInstrumentation';
const RUNNER_PACKAGE = 'com.nebula.controller';

export interface AndroidSupervisorConfig {
  readonly adbPath: string;
  readonly runnerApkPath: string;
  /** 맥 로컬 포워딩 포트 시작값 (iOS basePort 8200과 분리 — 기본 8300) */
  readonly basePort: number;
  readonly logDir: string;
  readonly controllerToken: string | null;
  /** 수퍼바이저 타이밍 (env 조정) — 미지정 시 기본값 */
  readonly tuning?: AndroidSupervisorTuning;
  /** 러너(device) 액션 타이밍 — instrument -e로 전달 */
  readonly runnerTuning?: AndroidRunnerTuning;
}

/** tuning 미지정 시 기본값 (테스트 호출부 호환) */
const DEFAULT_SUPERVISOR_TUNING: AndroidSupervisorTuning = {
  healthIntervalMs: 10_000,
  healthFailThreshold: 3,
  restartBaseMs: 2_000,
  restartMaxMs: 60_000,
  killEscalationMs: 3_000,
  portCooldownMs: 5_000,
  readyDeadlineMs: 60_000,
  reinstallAfterFailures: 3,
};

/** 외부 의존 주입 지점 — 테스트에서 가짜로 대체 */
export interface AndroidSupervisorDeps {
  /** 단발 adb 명령 (install/forward/shell 등) */
  readonly runAdb: (args: readonly string[], timeoutMs?: number) => Promise<Buffer>;
  /** 장수명 프로세스 spawn (am instrument -w) */
  readonly spawnProcess: (command: string, args: readonly string[], logPath: string) => ChildLike;
  readonly checkHealth: (baseUrl: string) => Promise<boolean>;
}

interface Session {
  readonly serial: string;
  readonly httpPort: number;
  instrument: TrackedProcess | null;
  isReady: boolean;
  isInstalled: boolean;
  healthFailCount: number;
  restartAttempt: number;
  healthTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  isStopping: boolean;
  /** 재기동 세대 — 옛 세대의 늦은 exit·헬스 응답 무시 */
  generation: number;
  launchedAtMs: number;
}

/**
 * Android 러너(instrumentation) 오케스트레이션 — install → adb forward → am instrument 기동·감시.
 * 러너가 iOS와 동일한 Controller HTTP 계약을 구현하므로 ControllerEndpointResolver로서
 * 기존 CommandExecutor·ControllerClient가 무변경으로 명령을 라우팅한다
 */
export class AndroidSupervisor implements ControllerEndpointResolver {
  private readonly sessions = new Map<string, Session>();
  private nextPortOffset = 0;
  private readonly freePorts: number[] = [];
  private terminating: TrackedProcess[] = [];
  private readonly deps: AndroidSupervisorDeps;
  private readonly tuning: AndroidSupervisorTuning;

  constructor(
    private readonly config: AndroidSupervisorConfig,
    deps: Partial<AndroidSupervisorDeps> = {},
  ) {
    this.tuning = config.tuning ?? DEFAULT_SUPERVISOR_TUNING;
    const adb = new AdbClient(config.adbPath);
    this.deps = {
      runAdb: deps.runAdb ?? ((args, timeoutMs) => adb.run(args, timeoutMs)),
      spawnProcess: deps.spawnProcess ?? spawnLogged,
      checkHealth: deps.checkHealth ?? makeControllerHealthCheck(config.controllerToken),
    };
  }

  /** 발견된 Android serial 집합과 세션 동기화 */
  syncDevices(serials: readonly string[]): void {
    const wanted = new Set(serials);
    for (const serial of wanted) {
      if (!this.sessions.has(serial)) this.startSession(serial);
    }
    for (const serial of [...this.sessions.keys()]) {
      if (!wanted.has(serial)) this.stopSession(serial);
    }
  }

  resolve(deviceId: string): string | null {
    const session = this.sessions.get(deviceId);
    if (!session) return null;
    return `http://127.0.0.1:${session.httpPort}`;
  }

  isReady(deviceId: string): boolean {
    return this.sessions.get(deviceId)?.isReady === true;
  }

  stopAll(): void {
    for (const serial of [...this.sessions.keys()]) this.stopSession(serial);
  }

  /** stop 후 자식(am instrument)이 실제로 죽을 때까지 대기 — Agent exit 전 고아 방지 */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      this.terminating = this.terminating.filter((tracked) => !tracked.hasExited);
      if (this.terminating.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const tracked of this.terminating) signalProcessTree(tracked, 'SIGKILL');
  }

  private startSession(serial: string): void {
    const session: Session = {
      serial,
      httpPort: this.allocatePort(),
      instrument: null,
      isReady: false,
      isInstalled: false,
      healthFailCount: 0,
      restartAttempt: 0,
      healthTimer: null,
      restartTimer: null,
      isStopping: false,
      generation: 0,
      launchedAtMs: 0,
    };
    this.sessions.set(serial, session);
    logger.info({ serial, httpPort: session.httpPort }, 'Android 러너 세션 시작');
    void this.launch(session);
  }

  private allocatePort(): number {
    const recycled = this.freePorts.shift();
    if (recycled !== undefined) return recycled;
    const port = this.config.basePort + this.nextPortOffset;
    this.nextPortOffset += 1;
    return port;
  }

  private async launch(session: Session): Promise<void> {
    const generation = session.generation;
    session.launchedAtMs = Date.now();
    try {
      await this.prepareDevice(session);
      if (this.isStale(session, generation)) return;
      this.spawnInstrument(session, generation);
      this.startHealthPolling(session, generation);
    } catch (error) {
      if (this.isStale(session, generation)) return;
      logger.warn({ err: error, serial: session.serial }, 'Android 러너 기동 실패 — 재기동 예약');
      this.scheduleRestart(session);
    }
  }

  /** 기동 전 준비: stayon → (필요 시) install → forward → 유령 러너 정리 */
  private async prepareDevice(session: Session): Promise<void> {
    const serial = session.serial;
    // 화면 꺼짐 상태에서 입력 주입이 막히는 것 방지 — 실패는 무시(권한·기기 정책 편차)
    await this.deps
      .runAdb(['-s', serial, 'shell', 'svc', 'power', 'stayon', 'usb'])
      .catch(() => logger.warn({ serial }, 'stayon 설정 실패 — 화면 꺼짐 시 주입이 막힐 수 있음'));

    // 연속 실패 시 재설치 강제 — 깨진 설치 상태 탈출구
    const needsInstall = !session.isInstalled || session.restartAttempt >= this.tuning.reinstallAfterFailures;
    if (needsInstall) {
      await this.deps.runAdb(['-s', serial, 'install', '-r', '-t', '-g', this.config.runnerApkPath], 60_000);
      session.isInstalled = true;
    }

    await this.deps.runAdb([
      '-s', serial, 'forward', `tcp:${session.httpPort}`, `tcp:${DEVICE_RUNNER_PORT}`,
    ]);
    // 이전 세대·수동 실행 잔재 정리 — 포트 8300 점유 유령 방지
    await this.deps.runAdb(['-s', serial, 'shell', 'am', 'force-stop', RUNNER_PACKAGE]);
  }

  private spawnInstrument(session: Session, generation: number): void {
    mkdirSync(this.config.logDir, { recursive: true });
    const logPath = join(this.config.logDir, `android-runner-${session.serial}.log`);
    const args = [
      // --no-hidden-api-checks만으로 test API 접근도 허용됨 (--no-test-api-access는 반대로 차단 플래그)
      '-s', session.serial, 'shell', 'am', 'instrument', '-w', '-r',
      '--no-hidden-api-checks',
      '-e', 'nebulaPort', String(DEVICE_RUNNER_PORT),
      ...this.tokenArgs(),
      ...this.runnerTuningArgs(),
      RUNNER_COMPONENT,
    ];
    const child = this.deps.spawnProcess(this.config.adbPath, args, logPath);
    const tracked: TrackedProcess = { child, hasExited: false };
    session.instrument = tracked;

    child.on('exit', (code) => {
      tracked.hasExited = true;
      if (this.isStale(session, generation)) return;
      logger.warn({ serial: session.serial, code }, 'Android 러너 종료 — 재기동');
      this.scheduleRestart(session);
    });
    child.on('error', (error) => {
      tracked.hasExited = true;
      if (this.isStale(session, generation)) return;
      logger.warn({ err: error, serial: session.serial }, 'Android 러너 spawn 오류 — 재기동');
      this.scheduleRestart(session);
    });
  }

  private tokenArgs(): readonly string[] {
    const token = this.config.controllerToken;
    if (!token) return [];
    return ['-e', 'nebulaToken', token];
  }

  /** 러너(device) 액션 타이밍을 -e 인자로 전달 — 미지정 시 러너 기본값 사용 */
  private runnerTuningArgs(): readonly string[] {
    const tuning = this.config.runnerTuning;
    if (!tuning) return [];
    return [
      '-e', 'nebulaActionTimeoutMs', String(tuning.actionTimeoutMs),
      '-e', 'nebulaSwipeStepMs', String(tuning.swipeStepMs),
      '-e', 'nebulaMaxSwipeMs', String(tuning.maxSwipeDurationMs),
    ];
  }

  private startHealthPolling(session: Session, generation: number): void {
    session.healthTimer = setInterval(
      () => void this.pollHealth(session, generation),
      this.tuning.healthIntervalMs,
    );
  }

  private async pollHealth(session: Session, generation: number): Promise<void> {
    const healthy = await this.deps.checkHealth(`http://127.0.0.1:${session.httpPort}`);
    if (this.isStale(session, generation)) return;

    if (healthy) {
      if (!session.isReady) logger.info({ serial: session.serial }, 'Android Controller 준비됨');
      session.isReady = true;
      session.healthFailCount = 0;
      session.restartAttempt = 0;
      return;
    }

    // 준비 전 데드라인 — unauthorized·APK 손상 등으로 영원히 not-ready인 wedge 차단
    if (!session.isReady && Date.now() - session.launchedAtMs > this.tuning.readyDeadlineMs) {
      logger.error({ serial: session.serial }, 'Android 러너 준비 데드라인 초과 — 강제 재기동');
      this.scheduleRestart(session);
      return;
    }
    if (!session.isReady) return;

    session.healthFailCount += 1;
    if (session.healthFailCount < this.tuning.healthFailThreshold) return;
    logger.warn({ serial: session.serial }, 'Android 러너 헬스 연속 실패 — 재기동');
    this.scheduleRestart(session);
  }

  private scheduleRestart(session: Session): void {
    if (session.isStopping || session.restartTimer) return;
    this.teardownProcesses(session);
    session.generation += 1;
    session.isReady = false;
    session.healthFailCount = 0;

    const delay = Math.min(this.tuning.restartBaseMs * 2 ** session.restartAttempt, this.tuning.restartMaxMs);
    session.restartAttempt += 1;
    logger.info({ serial: session.serial, delay, attempt: session.restartAttempt }, '재기동 예약');
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      void this.launch(session);
    }, delay);
  }

  private stopSession(serial: string): void {
    const session = this.sessions.get(serial);
    if (!session) return;
    session.isStopping = true;
    if (session.restartTimer) clearTimeout(session.restartTimer);
    this.teardownProcesses(session);
    this.sessions.delete(serial);

    // 기기측 러너·포워딩 정리 (기기가 이미 분리됐으면 조용히 실패)
    void this.deps
      .runAdb(['-s', serial, 'shell', 'am', 'force-stop', RUNNER_PACKAGE])
      .catch(() => undefined);
    void this.deps
      .runAdb(['-s', serial, 'forward', '--remove', `tcp:${session.httpPort}`])
      .catch(() => undefined);

    // 포트 반납은 쿨다운 후 — 잔존 forward와의 경합 방지 (iOS와 동일 정책)
    const cooldown = setTimeout(() => this.freePorts.push(session.httpPort), this.tuning.portCooldownMs);
    cooldown.unref();
    logger.info({ serial }, 'Android 러너 세션 정리');
  }

  private teardownProcesses(session: Session): void {
    if (session.healthTimer) {
      clearInterval(session.healthTimer);
      session.healthTimer = null;
    }
    const tracked = session.instrument;
    session.instrument = null;
    if (!tracked || tracked.hasExited) return;

    this.terminating.push(tracked);
    signalProcessTree(tracked, 'SIGTERM');
    const escalation = setTimeout(() => {
      if (tracked.hasExited) return;
      signalProcessTree(tracked, 'SIGKILL');
    }, this.tuning.killEscalationMs);
    escalation.unref();
  }

  private isStale(session: Session, generation: number): boolean {
    return session.isStopping || session.generation !== generation;
  }
}
