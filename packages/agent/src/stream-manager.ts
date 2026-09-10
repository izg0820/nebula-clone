import { logger } from './logger';

/** 기기당 미러링 스트림 공통 인터페이스 — H264Stream(iOS)·AndroidStream 공용 */
export interface DeviceStream {
  start(): void;
  stop(): void;
  /** stop 후 하위 프로세스가 실제로 죽을 때까지 대기 */
  awaitTermination(maxWaitMs: number): Promise<void>;
}

/** 플랫폼별 스트림 생성 — 생성 불가(설정 미비·이름 미상 등) 시 null, 다음 주기에 재시도됨 */
export type CreateDeviceStream = (deviceId: string) => DeviceStream | null;

/**
 * 미러링 상시 구동(pre-warm) 관리 — 기기당 스트림 1개.
 * 시청자와 무관하게 발견된 기기의 캡처를 유지, 기기가 사라질 때만 종료 (원문의 상시 운영 철학)
 */
export class StreamManager {
  private readonly streams = new Map<string, DeviceStream>();
  /** stopAll로 종료 신호를 보낸 스트림 — awaitTermination 대기 대상 */
  private readonly stopped: DeviceStream[] = [];

  constructor(private readonly createStream: CreateDeviceStream) {}

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
    logger.info({ deviceId }, '미러링 중지');
  }

  stopAll(): void {
    for (const [deviceId, stream] of [...this.streams]) {
      stream.stop();
      this.streams.delete(deviceId);
      // shutdown 전용 수집 — 개별 stop(기기 분리)은 Agent가 계속 살아 에스컬레이션 타이머가 처리
      this.stopped.push(stream);
      logger.info({ deviceId }, '미러링 중지');
    }
  }

  /** stopAll 후 하위 프로세스들이 실제로 죽을 때까지 대기 — Agent exit 전 고아 방지 */
  async awaitTermination(maxWaitMs: number): Promise<void> {
    await Promise.all(this.stopped.map((stream) => stream.awaitTermination(maxWaitMs)));
    this.stopped.length = 0;
  }

  private start(deviceId: string): void {
    if (this.streams.has(deviceId)) return;

    const stream = this.createStream(deviceId);
    if (!stream) return;

    this.streams.set(deviceId, stream);
    stream.start();
    logger.info({ deviceId }, '미러링 시작');
  }
}
