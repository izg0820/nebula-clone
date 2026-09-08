import { AgentFrame } from '@nebula/shared';
import { H264Stream } from './h264-stream';
import { logger } from './logger';

export interface StreamManagerOptions {
  /** mirror-helper 바이너리 경로 */
  readonly helperPath: string;
  /** deviceId → 기기 이름 (헬퍼의 --name 인자용, 발견 결과에서 갱신) */
  readonly resolveDeviceName: (deviceId: string) => string | null;
}

/**
 * H.264 미러링 상시 구동(pre-warm) 관리 — mirror-helper(캡처 장치) 프로세스 기기당 1개
 * 시청자와 무관하게 발견된 기기의 캡처를 유지, 기기가 사라질 때만 종료 (원문의 상시 운영 철학)
 */
export class StreamManager {
  private readonly streams = new Map<string, H264Stream>();
  /** stopAll로 종료 신호를 보낸 스트림 — awaitTermination 대기 대상 */
  private readonly stopped: H264Stream[] = [];

  constructor(
    private readonly sendFrame: (frame: AgentFrame) => boolean,
    private readonly options: StreamManagerOptions,
  ) {}

  /** 기기 발견 주기마다 호출 — 새 기기는 시작, 사라진 기기는 중지 */
  syncAlwaysOn(deviceIds: readonly string[]): void {
    for (const deviceId of deviceIds) this.start(deviceId);
    for (const deviceId of [...this.streams.keys()]) {
      if (!deviceIds.includes(deviceId)) this.stop(deviceId);
    }
  }

  stop(deviceId: string): void {
    const stream = this.streams.get(deviceId);
    if (!stream) return;
    stream.stop();
    this.streams.delete(deviceId);
    logger.info({ deviceId }, 'H.264 미러링 중지');
  }

  stopAll(): void {
    for (const [deviceId, stream] of [...this.streams]) {
      stream.stop();
      this.streams.delete(deviceId);
      // shutdown 전용 수집 — 개별 stop(기기 분리)은 Agent가 계속 살아 에스컬레이션 타이머가 처리
      this.stopped.push(stream);
      logger.info({ deviceId }, 'H.264 미러링 중지');
    }
  }

  /** stopAll 후 헬퍼들이 실제로 죽을 때까지 대기 — Agent exit 전 고아 방지 */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    await Promise.all(this.stopped.map((stream) => stream.awaitTermination(maxWaitMs)));
    this.stopped.length = 0;
  }

  /** 기기 이름 미상이면 보류 — 다음 발견 주기에 재시도됨 */
  private start(deviceId: string): void {
    if (this.streams.has(deviceId)) return;

    const deviceName = this.options.resolveDeviceName(deviceId);
    if (!deviceName) {
      logger.warn({ deviceId }, '기기 이름 미상 — 미러링 보류');
      return;
    }

    const stream = new H264Stream(
      { helperPath: this.options.helperPath, deviceName, deviceId },
      this.sendFrame,
    );
    this.streams.set(deviceId, stream);
    stream.start();
    logger.info({ deviceId, deviceName }, 'H.264 미러링 시작');
  }
}
