/** 디바이스 공통 타입 */

export type DevicePlatform = 'ios' | 'android';

const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['ios', 'android'];

/** 신뢰 경계 검증용 타입 가드 — 새 플랫폼은 여기와 서버 DTO enum에 함께 추가 */
export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return DEVICE_PLATFORMS.includes(value as DevicePlatform);
}

/** Agent가 서버에 등록하는 디바이스 정보 */
export interface RegisterDeviceInput {
  readonly id: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly osVersion: string;
  readonly tags: readonly string[];
}
