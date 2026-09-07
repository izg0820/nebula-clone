import { ChildProcess, spawn } from 'child_process';
import { AgentFrame, FRAME_FORMAT_H264 } from '@nebula/shared';
import { logger } from './logger';

/** 헬퍼 사망 시 재기동 대기 */
const HELPER_RESTART_MS = 2_000;
/** 패킷 상한 — 손상 스트림으로 인한 메모리 폭주 방지 */
const MAX_PACKET_BYTES = 8 * 1024 * 1024;

/** mirror-helper stdout 패킷([u32BE len][u8 isKey][Annex-B]) 증분 파서 */
export class HelperPacketParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** 수신 청크 추가 후 완성된 패킷들 반환. 손상 감지 시 null (스트림 재시작 필요) */
  push(chunk: Buffer): Array<{ isKey: boolean; payload: Buffer }> | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: Array<{ isKey: boolean; payload: Buffer }> = [];

    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_PACKET_BYTES) return null;
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
  private isActive = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private width = 0;
  private height = 0;

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
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private launch(): void {
    const parser = new HelperPacketParser();
    const child = spawn(this.config.helperPath, ['--name', this.config.deviceName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

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
    if (!this.isActive || this.width === 0) return;
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
      logger.info(
        { deviceId: this.config.deviceId, width: this.width, height: this.height },
        'H.264 미러링 스트림 활성',
      );
    }
  }

  private scheduleRestart(): void {
    if (!this.isActive || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isActive) return;
      this.launch();
    }, HELPER_RESTART_MS);
  }
}
