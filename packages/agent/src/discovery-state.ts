import { logger } from './logger';
import { RegisterDeviceInput } from '@nebula/shared';

/** 이 횟수 연속 발견 실패 시에만 기기 목록을 비움 — 일시 오류로 점유가 풀리는 것 방지 */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * 발견 결과 상태 머신
 * - 성공: 목록 교체, 실패 카운터 리셋
 * - 실패(null): 직전 목록 유지, 연속 실패 임계치 초과 시에만 비움
 */
export class DiscoveryState {
  private devices: readonly RegisterDeviceInput[] = [];
  private consecutiveFailures = 0;

  get current(): readonly RegisterDeviceInput[] {
    return this.devices;
  }

  /**
   * 발견 결과 반영
   * @return 서버에 register를 보내야 하면 true (성공한 발견만 등록 대상)
   */
  apply(result: readonly RegisterDeviceInput[] | null): boolean {
    if (result !== null) {
      this.devices = result;
      this.consecutiveFailures = 0;
      return true;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      logger.warn(
        { consecutiveFailures: this.consecutiveFailures },
        '발견 실패 — 직전 기기 목록 유지',
      );
      return false;
    }

    if (this.devices.length > 0) {
      logger.error(
        { consecutiveFailures: this.consecutiveFailures },
        `발견 ${MAX_CONSECUTIVE_FAILURES}회 연속 실패 — 기기 목록 비움`,
      );
    }
    this.devices = [];
    return false;
  }
}
