import { AgentFrame, FRAME_FORMAT_JPEG } from '@nebula/shared';
import { ControllerClient } from './controller-client';
import { ControllerEndpointResolver } from './controller-registry';
import { H264Stream } from './h264-stream';
import { logger } from './logger';

/** JPEG 폴백: 프레임 간 최소 대기 (캡처 자체가 ~150ms라 실효 ~6fps) */
const FRAME_GAP_MS = 30;
/** 캡처 실패 시 재시도 대기 */
const FAILURE_RETRY_MS = 1_000;

/** Controller /screenshot 응답 형태 */
interface ScreenshotPayload {
  readonly jpegBase64: string;
  readonly widthPt: number;
  readonly heightPt: number;
}

function isScreenshotPayload(value: unknown): value is ScreenshotPayload {
  const record = value as Record<string, unknown> | null;
  return (
    typeof record?.jpegBase64 === 'string' &&
    typeof record?.widthPt === 'number' &&
    typeof record?.heightPt === 'number'
  );
}

export interface StreamManagerOptions {
  /** mirror-helper 바이너리 경로 — 지정 시 H.264 모드, 미지정 시 JPEG 폴백 */
  readonly helperPath: string | null;
  /** deviceId → 기기 이름 (헬퍼의 --name 인자용, 발견 결과에서 갱신) */
  readonly resolveDeviceName: (deviceId: string) => string | null;
}

/**
 * 미러링 스트림 관리 — 서버의 startStream/stopStream 지시에 따라 기기별 스트림 구동
 * H.264 모드: mirror-helper(캡처 장치) 프로세스 — ~30-60fps
 * JPEG 모드: XCUITest 스크린샷 폴링 — ~3-6fps (캡처 장치가 없는 환경 폴백)
 */
export class StreamManager {
  private readonly jpegStreams = new Map<string, { isActive: boolean }>();
  private readonly h264Streams = new Map<string, H264Stream>();

  constructor(
    private readonly resolver: ControllerEndpointResolver,
    private readonly sendFrame: (frame: AgentFrame) => boolean,
    private readonly options: StreamManagerOptions,
  ) {}

  /**
   * H.264 상시 구동(pre-warm) 동기화 — 기기 발견 주기마다 호출.
   * 시청자와 무관하게 준비된 기기의 캡처를 유지, 기기가 사라질 때만 종료 (원문의 상시 운영 철학)
   */
  syncAlwaysOn(deviceIds: readonly string[]): void {
    if (!this.options.helperPath) return; // JPEG 폴백은 시청자 게이트 유지

    for (const deviceId of deviceIds) this.startH264(deviceId);
    for (const deviceId of [...this.h264Streams.keys()]) {
      if (!deviceIds.includes(deviceId)) this.stop(deviceId);
    }
  }

  /** 서버의 시청자 기반 start/stop — H.264 상시 모드에서는 무시 (JPEG 폴백 전용) */
  handleStreamControl(deviceId: string, shouldStart: boolean): void {
    if (this.options.helperPath) {
      // 상시 모드: 시작은 syncAlwaysOn이 담당, 중지는 pre-warm 유지 위해 무시
      if (shouldStart) this.startH264(deviceId);
      return;
    }
    if (shouldStart) {
      this.startJpeg(deviceId);
      return;
    }
    this.stop(deviceId);
  }

  stop(deviceId: string): void {
    const h264 = this.h264Streams.get(deviceId);
    if (h264) {
      h264.stop();
      this.h264Streams.delete(deviceId);
      logger.info({ deviceId }, 'H.264 미러링 중지');
    }

    const jpeg = this.jpegStreams.get(deviceId);
    if (jpeg) {
      jpeg.isActive = false;
      this.jpegStreams.delete(deviceId);
      logger.info({ deviceId }, 'JPEG 미러링 중지');
    }
  }

  stopAll(): void {
    for (const deviceId of [...this.h264Streams.keys(), ...this.jpegStreams.keys()]) {
      this.stop(deviceId);
    }
  }

  /** H.264 모드 시작 — 헬퍼 미설정·기기 이름 미상이면 false (JPEG 폴백) */
  private startH264(deviceId: string): boolean {
    if (!this.options.helperPath) return false;
    if (this.h264Streams.has(deviceId)) return true;

    const deviceName = this.options.resolveDeviceName(deviceId);
    if (!deviceName) {
      logger.warn({ deviceId }, '기기 이름 미상 — JPEG 폴백');
      return false;
    }

    const stream = new H264Stream(
      { helperPath: this.options.helperPath, deviceName, deviceId },
      this.sendFrame,
    );
    this.h264Streams.set(deviceId, stream);
    stream.start();
    logger.info({ deviceId, deviceName }, 'H.264 미러링 시작');
    return true;
  }

  private startJpeg(deviceId: string): void {
    if (this.jpegStreams.has(deviceId)) return;
    const handle = { isActive: true };
    this.jpegStreams.set(deviceId, handle);
    logger.info({ deviceId }, 'JPEG 미러링 시작 (폴백)');
    void this.jpegLoop(deviceId, handle);
  }

  private async jpegLoop(deviceId: string, handle: { isActive: boolean }): Promise<void> {
    while (handle.isActive) {
      const delay = await this.captureJpegOnce(deviceId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** JPEG 1프레임 캡처·전송 — 다음 시도까지의 대기 시간 반환 */
  private async captureJpegOnce(deviceId: string): Promise<number> {
    const baseUrl = this.resolver.resolve(deviceId);
    if (!baseUrl || !this.resolver.isReady(deviceId)) return FAILURE_RETRY_MS;

    const client = new ControllerClient(baseUrl);
    const outcome = await client.execute({ kind: 'screenshot' });
    if (!outcome.ok || !isScreenshotPayload(outcome.result)) return FAILURE_RETRY_MS;

    const { jpegBase64, widthPt, heightPt } = outcome.result;
    const sent = this.sendFrame({
      deviceId,
      format: FRAME_FORMAT_JPEG,
      isKey: true,
      width: Math.round(widthPt),
      height: Math.round(heightPt),
      payload: Uint8Array.from(Buffer.from(jpegBase64, 'base64')),
    });
    if (!sent) return FAILURE_RETRY_MS;
    return FRAME_GAP_MS;
  }
}
