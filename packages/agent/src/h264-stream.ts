import { ChildProcess, spawn } from 'child_process';
import { AgentFrame, FRAME_FORMAT_H264 } from '@nebula/shared';
import { logger } from './logger';

/** 헬퍼 사망 시 재기동 백오프 (지수, 상한 60초) — 경로 오타·장치 미발행의 2초 무한 폭주 방지 */
const HELPER_RESTART_BASE_MS = 2_000;
const HELPER_RESTART_MAX_MS = 60_000;
/** 연속 재기동이 이 횟수를 넘으면 warn → error 승격 (설정 오류 가능성) */
const RESTART_ERROR_THRESHOLD = 5;
/** SIGTERM 후 이 시간 내 미종료 시 SIGKILL — 행한 헬퍼가 캡처 장치를 계속 점유하는 것 방지 */
const KILL_ESCALATION_MS = 2_000;
/** 기동 후 이 시간 내 해상도(stderr 로그) 미확보 시 재기동 — 프레임 무음 폐기 방지 */
const RESOLUTION_DEADLINE_MS = 20_000;
/** 해상도 미확보로 폐기한 프레임 로그 주기 */
const DROPPED_LOG_INTERVAL = 100;
/** 패킷 상한 — 손상 스트림으로 인한 메모리 폭주 방지 */
const MAX_PACKET_BYTES = 8 * 1024 * 1024;

/** mirror-helper stdout 패킷([u32BE len][u8 isKey][Annex-B]) 증분 파서 */
export class HelperPacketParser {
  private buffer: Buffer = Buffer.alloc(0);
  /** 손상 감지 후 재개 금지 — 재시작 전까지 도착하는 청크가 버퍼에 쌓이지 않게 */
  private isPoisoned = false;

  /** 수신 청크 추가 후 완성된 패킷들 반환. 손상 감지 시 null (스트림 재시작 필요) */
  push(chunk: Buffer): Array<{ isKey: boolean; payload: Buffer }> | null {
    if (this.isPoisoned) return null;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: Array<{ isKey: boolean; payload: Buffer }> = [];

    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_PACKET_BYTES) {
        this.isPoisoned = true;
        this.buffer = Buffer.alloc(0);
        return null;
      }
      if (this.buffer.length < 5 + length) break;

      packets.push({
        isKey: this.buffer[4] === 1,
        payload: this.buffer.subarray(5, 5 + length),
      });
      this.buffer = this.buffer.subarray(5 + length);
    }
    return packets;
  }
}

export interface H264StreamConfig {
  readonly helperPath: string;
  readonly deviceName: string;
  /** 인코더 해상도 — 헬퍼 stderr 로그에서 파싱하기 전까지 기본값 (프레임 헤더용) */
  readonly deviceId: string;
}

/**
 * mirror-helper(캡처 장치 → H.264) 프로세스 1개 관리 — 기기당 1세션
 * 헬퍼가 죽으면 활성 상태인 동안 자동 재기동
 */
export class H264Stream {
  private child: ChildProcess | null = null;
  /** 종료 신호를 보냈지만 exit 확인 전인 헬퍼 — awaitTermination 대기 대상 */
  private terminatingChild: ChildProcess | null = null;
  private isActive = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private resolutionTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private width = 0;
  private height = 0;
  /** 해상도 미확보 상태에서 폐기한 프레임 수 — 무음 폐기 방지용 관측 */
  private droppedBeforeResolution = 0;

  constructor(
    private readonly config: H264StreamConfig,
    private readonly sendFrame: (frame: AgentFrame) => boolean,
  ) {}

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.launch();
  }

  stop(): void {
    this.isActive = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearResolutionTimer();
    const child = this.child;
    this.child = null;
    if (!child) return;

    this.terminatingChild = child;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      logger.warn({ deviceId: this.config.deviceId }, '헬퍼 SIGTERM 미응답 — SIGKILL');
      child.kill('SIGKILL');
    }, KILL_ESCALATION_MS);
    escalation.unref();
  }

  /**
   * stop 후 헬퍼가 실제로 죽을 때까지 대기 — Agent가 먼저 exit하면 unref된
   * SIGKILL 에스컬레이션 타이머가 소멸해 SIGTERM 미응답 헬퍼가 고아로 남음 (실사용에서 겪음)
   */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    const child = this.terminatingChild;
    if (!child) return;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.terminatingChild = null;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.warn({ deviceId: this.config.deviceId }, '헬퍼 종료 대기 초과 — SIGKILL');
    child.kill('SIGKILL');
    this.terminatingChild = null;
  }

  private launch(): void {
    const parser = new HelperPacketParser();
    // 새 헬퍼 세션의 프레임이 이전 세션 해상도로 나가지 않도록 리셋
    this.width = 0;
    this.height = 0;
    this.droppedBeforeResolution = 0;
    const child = spawn(this.config.helperPath, ['--name', this.config.deviceName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.armResolutionDeadline(child);

    child.stdout?.on('data', (chunk: Buffer) => {
      const packets = parser.push(chunk);
      if (packets === null) {
        logger.warn({ deviceId: this.config.deviceId }, '헬퍼 스트림 손상 — 재시작');
        child.kill('SIGTERM');
        return;
      }
      for (const packet of packets) this.emit(packet.isKey, packet.payload);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.parseHelperLog(chunk.toString());
    });
    child.on('error', (error: Error) => {
      logger.warn({ err: error }, 'mirror-helper 실행 실패');
      this.scheduleRestart();
    });
    child.on('exit', (code: number | null) => {
      if (!this.isActive) return;
      logger.warn({ deviceId: this.config.deviceId, code }, 'mirror-helper 종료 — 재기동');
      this.scheduleRestart();
    });
  }

  private emit(isKey: boolean, payload: Buffer): void {
    if (!this.isActive) return;
    if (this.width === 0) {
      // 해상도(stderr 계약) 미확보 — 무음 폐기 금지, 주기적으로 관측 가능하게
      this.droppedBeforeResolution += 1;
      if (this.droppedBeforeResolution % DROPPED_LOG_INTERVAL === 1) {
        logger.warn(
          { deviceId: this.config.deviceId, dropped: this.droppedBeforeResolution },
          '해상도 미확보로 프레임 폐기 중 (헬퍼 stderr 계약 확인 필요)',
        );
      }
      return;
    }
    this.sendFrame({
      deviceId: this.config.deviceId,
      format: FRAME_FORMAT_H264,
      isKey,
      width: this.width,
      height: this.height,
      stampMs: Date.now(),
      payload: Uint8Array.from(payload),
    });
  }

  /** 헬퍼 stderr에서 인코더 해상도 파싱: "인코더 초기화: 1290x2796" */
  private parseHelperLog(text: string): void {
    const match = /인코더 초기화: (\d+)x(\d+)/.exec(text);
    if (match) {
      this.width = Number(match[1]);
      this.height = Number(match[2]);
      this.restartAttempt = 0;
      this.clearResolutionTimer();
      logger.info(
        { deviceId: this.config.deviceId, width: this.width, height: this.height },
        'H.264 미러링 스트림 활성',
      );
    }
  }

  /** 기동 후 해상도 미확보가 지속되면 헬퍼 재기동 — stderr 계약 불일치가 무음 폐기로 남지 않게 */
  private armResolutionDeadline(child: ChildProcess): void {
    this.clearResolutionTimer();
    this.resolutionTimer = setTimeout(() => {
      this.resolutionTimer = null;
      if (!this.isActive || this.child !== child || this.width !== 0) return;
      logger.error(
        { deviceId: this.config.deviceId, dropped: this.droppedBeforeResolution },
        '해상도 확보 실패 — 헬퍼 재기동 (stderr 계약 "인코더 초기화: WxH" 미수신)',
      );
      child.kill('SIGTERM');
    }, RESOLUTION_DEADLINE_MS);
    this.resolutionTimer.unref();
  }

  private clearResolutionTimer(): void {
    if (!this.resolutionTimer) return;
    clearTimeout(this.resolutionTimer);
    this.resolutionTimer = null;
  }

  private scheduleRestart(): void {
    if (!this.isActive || this.restartTimer) return;
    this.clearResolutionTimer();

    const delay = Math.min(HELPER_RESTART_BASE_MS * 2 ** this.restartAttempt, HELPER_RESTART_MAX_MS);
    this.restartAttempt += 1;
    if (this.restartAttempt >= RESTART_ERROR_THRESHOLD) {
      logger.error(
        { deviceId: this.config.deviceId, attempt: this.restartAttempt, delay },
        '헬퍼 연속 재기동 — 설정(NEBULA_MIRROR_HELPER 경로)·캡처 장치 발행 상태 확인 필요',
      );
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isActive) return;
      this.launch();
    }, delay);
  }
}
