/** 디바이스 공통 타입 */

export type DevicePlatform = 'ios';

/** Agent가 서버에 등록하는 디바이스 정보 */
export interface RegisterDeviceInput {
  readonly id: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly osVersion: string;
  readonly tags: readonly string[];
}
