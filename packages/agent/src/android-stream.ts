import { connect as netConnect } from 'net';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { AgentFrame, FRAME_FORMAT_H264 } from '@nebula/shared';
import { AdbClient } from './adb-client';
import { AndroidMirrorTuning } from './config';
import { logger } from './logger';
import { MirrorPacketParser } from './mirror-packet-parser';
import { ChildLike, signalProcessTree, spawnLogged, TrackedProcess } from './process-tree';

/** 기기측 고정 계약 — MirrorDaemon.kt와 일치 */
const DEVICE_DEX_PATH = '/data/local/tmp/nebula-mirror.jar';
const SOCKET_NAME = 'nebula-mirror';
const DAEMON_ENTRY = 'com.nebula.mirror.MirrorDaemonKt';

/** tuning 미지정 시 기본값 (테스트 호출부 호환) */
const DEFAULT_MIRROR_TUNING: AndroidMirrorTuning = {
  restartBaseMs: 2_000,
  restartMaxMs: 60_000,
  errorThreshold: 5,
  killEscalationMs: 2_000,
  preambleDeadlineMs: 10_000,
  connectRetryMs: 500,
  bitRate: 8_000_000,
  fps: 60,
  iframeIntervalSec: 1,
  repeatFrameMs: 100,
  swapPollMs: 500,
  acceptDeadlineMs: 30_000,
};

export interface AndroidStreamConfig {
  readonly adbPath: string;
  readonly serial: string;
  readonly mirrorDexPath: string;
  /** 맥 로컬 포워딩 포트 (localabstract → tcp) */
  readonly mirrorPort: number;
  readonly logDir: string;
  /** 미러링 타이밍 (env 조정) — 미지정 시 기본값 */
  readonly tuning?: AndroidMirrorTuning;
}

/** 소켓 최소 인터페이스 (테스트 주입용) */
export interface SocketLike {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  destroy(): void;
}

/** 외부 의존 주입 지점 — 테스트에서 가짜로 대체 */
export interface AndroidStreamDeps {
  readonly runAdb: (args: readonly string[], timeoutMs?: number) => Promise<Buffer>;
  readonly spawnDaemon: (logPath: string) => ChildLike;
  readonly connect: (port: number) => SocketLike;
}

interface DaemonSession {
  child: ChildLike | null;
  tracked: TrackedProcess | null;
  socket: SocketLike | null;
  parser: MirrorPacketParser;
}

/**
 * Android 미러링 스트림 1개(기기당 1세션) — 데몬 dex push → app_process 기동 →
 * adb forward(localabstract) → TCP 수신 → AgentFrame 방출. 죽으면 백오프 재기동
 */
export class AndroidStream {
  private session: DaemonSession | null = null;
  private isActive = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private preambleTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private terminating: TrackedProcess[] = [];
  private readonly deps: AndroidStreamDeps;
  private readonly tuning: AndroidMirrorTuning;

  constructor(
    private readonly config: AndroidStreamConfig,
    private readonly sendFrame: (frame: AgentFrame) => boolean,
    deps: Partial<AndroidStreamDeps> = {},
  ) {
    this.tuning = config.tuning ?? DEFAULT_MIRROR_TUNING;
    const adb = new AdbClient(config.adbPath);
    const tuning = this.tuning;
    this.deps = {
      runAdb: deps.runAdb ?? ((args, timeoutMs) => adb.run(args, timeoutMs)),
      spawnDaemon:
        deps.spawnDaemon ??
        ((logPath) =>
          spawnLogged(config.adbPath, [
            '-s', config.serial, 'shell',
            `CLASSPATH=${DEVICE_DEX_PATH}`, 'app_process', '/', DAEMON_ENTRY,
            // device 인코더 데몬 튜닝 전달 (Args.kt와 계약 일치)
            '--bitrate', String(tuning.bitRate),
            '--fps', String(tuning.fps),
            '--iframe', String(tuning.iframeIntervalSec),
            '--repeat-ms', String(tuning.repeatFrameMs),
            '--swap-poll-ms', String(tuning.swapPollMs),
            '--accept-deadline-ms', String(tuning.acceptDeadlineMs),
          ], logPath)),
      connect: deps.connect ?? ((port) => netConnect(port, '127.0.0.1')),
    };
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    void this.launch();
  }

  stop(): void {
    this.isActive = false;
    this.clearTimers();
    this.teardownSession();
    // 포워딩 정리 (기기가 이미 분리됐으면 조용히 실패)
    void this.deps
      .runAdb(['-s', this.config.serial, 'forward', '--remove', `tcp:${this.config.mirrorPort}`])
      .catch(() => undefined);
  }

  /** stop 후 데몬(adb shell)이 실제로 죽을 때까지 대기 — Agent exit 전 고아 방지 */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      this.terminating = this.terminating.filter((tracked) => !tracked.hasExited);
      if (this.terminating.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const tracked of this.terminating) signalProcessTree(tracked, 'SIGKILL');
  }

  private async launch(): Promise<void> {
    const session: DaemonSession = {
      child: null,
      tracked: null,
      socket: null,
      parser: new MirrorPacketParser(),
    };
    this.session = session;
    try {
      // 매 기동마다 push — 빌드 갱신 자동 반영 (2.4MB, USB에서 수십 ms)
      await this.deps.runAdb(
        ['-s', this.config.serial, 'push', this.config.mirrorDexPath, DEVICE_DEX_PATH],
        15_000,
      );
      if (!this.isActive || this.session !== session) return;

      this.spawnDaemon(session);
      await this.deps.runAdb([
        '-s', this.config.serial, 'forward', `tcp:${this.config.mirrorPort}`, `localabstract:${SOCKET_NAME}`,
      ]);
      if (!this.isActive || this.session !== session) return;

      this.armPreambleDeadline(session);
      this.connectSocket(session);
    } catch (error) {
      if (!this.isActive || this.session !== session) return;
      logger.warn({ err: error, serial: this.config.serial }, '미러링 데몬 기동 실패 — 재기동 예약');
      this.scheduleRestart();
    }
  }

  private spawnDaemon(session: DaemonSession): void {
    mkdirSync(this.config.logDir, { recursive: true });
    const logPath = join(this.config.logDir, `android-mirror-${this.config.serial}.log`);
    const child = this.deps.spawnDaemon(logPath);
    const tracked: TrackedProcess = { child, hasExited: false };
    session.child = child;
    session.tracked = tracked;

    child.on('exit', (code) => {
      tracked.hasExited = true;
      if (!this.isActive || this.session !== session) return;
      logger.warn({ serial: this.config.serial, code }, '미러링 데몬 종료 — 재기동');
      this.scheduleRestart();
    });
    child.on('error', (error) => {
      tracked.hasExited = true;
      if (!this.isActive || this.session !== session) return;
      logger.warn({ err: error, serial: this.config.serial }, '미러링 데몬 spawn 오류 — 재기동');
      this.scheduleRestart();
    });
  }

  /** 데몬 listen 전 접속 거부는 프리앰블 데드라인 안에서 재시도 */
  private connectSocket(session: DaemonSession): void {
    const socket = this.deps.connect(this.config.mirrorPort);
    session.socket = socket;

    socket.on('data', (chunk) => {
      if (this.session !== session) return;
      this.handleChunk(session, chunk);
    });
    socket.on('error', () => undefined); // close에서 일괄 처리 (error+close 중복 방지)
    socket.on('close', () => {
      if (!this.isActive || this.session !== session) return;
      if (!session.parser.preamble) {
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (!this.isActive || this.session !== session) return;
          this.connectSocket(session);
        }, this.tuning.connectRetryMs);
        return;
      }
      logger.warn({ serial: this.config.serial }, '미러링 소켓 단선 — 재기동');
      this.scheduleRestart();
    });
  }

  private handleChunk(session: DaemonSession, chunk: Buffer): void {
    const hadPreamble = session.parser.preamble !== null;
    const packets = session.parser.push(chunk);
    if (packets === null) {
      logger.warn({ serial: this.config.serial }, '미러링 스트림 손상 — 재기동');
      this.scheduleRestart();
      return;
    }
    if (!hadPreamble && session.parser.preamble) {
      this.restartAttempt = 0;
      this.clearPreambleTimer();
      logger.info(
        { serial: this.config.serial, ...session.parser.preamble },
        'Android 미러링 스트림 활성',
      );
    }
    for (const packet of packets) {
      this.sendFrame({
        deviceId: this.config.serial,
        format: FRAME_FORMAT_H264,
        isKey: packet.isKey,
        width: packet.width,
        height: packet.height,
        stampMs: Date.now(),
        payload: Uint8Array.from(packet.payload),
      });
    }
  }

  private armPreambleDeadline(session: DaemonSession): void {
    this.clearPreambleTimer();
    this.preambleTimer = setTimeout(() => {
      this.preambleTimer = null;
      if (!this.isActive || this.session !== session || session.parser.preamble) return;
      logger.error({ serial: this.config.serial }, '프리앰블 데드라인 초과 — 데몬 재기동');
      this.scheduleRestart();
    }, this.tuning.preambleDeadlineMs);
    this.preambleTimer.unref();
  }

  private scheduleRestart(): void {
    if (!this.isActive || this.restartTimer) return;
    this.clearTimers();
    this.teardownSession();

    const delay = Math.min(this.tuning.restartBaseMs * 2 ** this.restartAttempt, this.tuning.restartMaxMs);
    this.restartAttempt += 1;
    if (this.restartAttempt >= this.tuning.errorThreshold) {
      logger.error(
        { serial: this.config.serial, attempt: this.restartAttempt, delay },
        '미러링 연속 재기동 — 데몬 로그(android-mirror-*.log)·hidden API 지원 여부 확인 필요',
      );
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isActive) return;
      void this.launch();
    }, delay);
  }

  private teardownSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;

    session.socket?.destroy();
    const tracked = session.tracked;
    if (!tracked || tracked.hasExited) return;

    this.terminating.push(tracked);
    signalProcessTree(tracked, 'SIGTERM');
    const escalation = setTimeout(() => {
      if (tracked.hasExited) return;
      signalProcessTree(tracked, 'SIGKILL');
    }, this.tuning.killEscalationMs);
    escalation.unref();
  }

  private clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.clearPreambleTimer();
  }

  private clearPreambleTimer(): void {
    if (!this.preambleTimer) return;
    clearTimeout(this.preambleTimer);
    this.preambleTimer = null;
  }
}
