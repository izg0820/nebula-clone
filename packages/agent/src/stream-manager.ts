import { AgentFrame } from '@nebula/shared';
import { ControllerClient } from './controller-client';
import { ControllerEndpointResolver } from './controller-registry';
import { logger } from './logger';

/** 프레임 간 최소 대기 — Controller 과점유 방지 (캡처 자체가 ~150ms라 실효 ~6-10fps) */
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

/**
 * 미러링 스트림 관리 — 서버의 startStream/stopStream 지시에 따라
 * 기기별 연속 캡처 루프를 돌리고 프레임을 터널로 푸시
 */
export class StreamManager {
  /** deviceId → 활성 루프 중단 플래그 */
  private readonly activeStreams = new Map<string, { isActive: boolean }>();

  constructor(
    private readonly resolver: ControllerEndpointResolver,
    private readonly sendFrame: (frame: AgentFrame) => boolean,
  ) {}

  start(deviceId: string): void {
    if (this.activeStreams.has(deviceId)) return;
    const handle = { isActive: true };
    this.activeStreams.set(deviceId, handle);
    logger.info({ deviceId }, '미러링 스트림 시작');
    void this.captureLoop(deviceId, handle);
  }

  stop(deviceId: string): void {
    const handle = this.activeStreams.get(deviceId);
    if (!handle) return;
    handle.isActive = false;
    this.activeStreams.delete(deviceId);
    logger.info({ deviceId }, '미러링 스트림 중지');
  }

  stopAll(): void {
    for (const deviceId of [...this.activeStreams.keys()]) this.stop(deviceId);
  }

  private async captureLoop(deviceId: string, handle: { isActive: boolean }): Promise<void> {
    while (handle.isActive) {
      const delay = await this.captureOne(deviceId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** 1프레임 캡처·전송 — 다음 시도까지의 대기 시간 반환 */
  private async captureOne(deviceId: string): Promise<number> {
    const baseUrl = this.resolver.resolve(deviceId);
    if (!baseUrl || !this.resolver.isReady(deviceId)) return FAILURE_RETRY_MS;

    const client = new ControllerClient(baseUrl);
    const outcome = await client.execute({ kind: 'screenshot' });
    if (!outcome.ok || !isScreenshotPayload(outcome.result)) return FAILURE_RETRY_MS;

    const { jpegBase64, widthPt, heightPt } = outcome.result;
    const jpeg = Uint8Array.from(Buffer.from(jpegBase64, 'base64'));
    const sent = this.sendFrame({
      deviceId,
      widthPt: Math.round(widthPt),
      heightPt: Math.round(heightPt),
      jpeg,
    });
    if (!sent) return FAILURE_RETRY_MS;
    return FRAME_GAP_MS;
  }
}
