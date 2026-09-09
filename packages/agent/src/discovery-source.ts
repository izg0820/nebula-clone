import { DevicePlatform, RegisterDeviceInput } from '@nebula/shared';

/**
 * 플랫폼별 기기 발견 소스 — discover()의 null은 "발견 실패"(기기 없음 []과 구별).
 * 실패 카운팅(직전 목록 유지)은 소스 단위 속성이므로 DiscoveryState도 소스마다 하나씩
 */
export interface DiscoverySource {
  readonly platform: DevicePlatform;
  discover(): Promise<readonly RegisterDeviceInput[] | null>;
}
