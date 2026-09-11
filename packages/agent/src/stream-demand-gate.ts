import { logger } from './logger';

/**
 * 시청 수요 게이트 — 캡처(pre-warm)와 네트워크 전송을 분리
 *
 * 미러링 캡처는 기기 발견 주기마다 상시 구동되지만, 아무도 보고 있지 않은 화면을
 * 업링크로 밀어 올릴 이유는 없다. 같은 소켓 큐를 제어 응답·하트비트가 공유하므로
 * 낭비 전송은 곧 제어 지연이다.
 *
 * 서버가 스냅샷을 한 번도 보내지 않은 동안에는 전송을 허용한다 —
 * 수요 프로토콜을 모르는 구버전 서버에 붙었을 때 미러링이 조용히 멎지 않도록
 */
export class StreamDemandGate {
  private demanded = new Set<string>();
  private hasSnapshot = false;

  /** 서버 수요 스냅샷 반영 (전체 목록 교체) */
  apply(deviceIds: readonly string[]): void {
    this.hasSnapshot = true;
    this.demanded = new Set(deviceIds);
    logger.debug({ deviceIds }, '전송 대상 기기 갱신');
  }

  /** 터널 단선 — 재연결 후 서버 스냅샷을 다시 받기 전까지는 구버전 서버와 동일하게 취급 */
  reset(): void {
    this.hasSnapshot = false;
    this.demanded = new Set();
  }

  shouldSend(deviceId: string): boolean {
    if (!this.hasSnapshot) return true;
    return this.demanded.has(deviceId);
  }
}
