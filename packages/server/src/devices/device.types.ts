import { DevicePlatform, RegisterDeviceInput } from '@nebula/shared';

/** 디바이스 도메인 타입 — 프로토콜 공통 타입은 @nebula/shared에서 가져옴 */

export { DevicePlatform, RegisterDeviceInput };
export type DeviceStatus = 'online' | 'offline';

/** 레지스트리에 저장되는 디바이스 상태 */
export interface Device {
  /** 기기 UDID */
  readonly id: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly osVersion: string;
  readonly tags: readonly string[];
  readonly status: DeviceStatus;
  /** 이 기기를 관리하는 Agent ID (오프라인 시 null) */
  readonly agentId: string | null;
  /** 현재 점유자 ID (미점유 시 null) */
  readonly occupantId: string | null;
  /** 점유 시각 (ISO) */
  readonly occupiedAt: string | null;
  /** 마지막 하트비트 시각 (ISO) */
  readonly lastHeartbeatAt: string | null;
}

/** 클라이언트 응답용 디바이스 — 해제 비밀값인 occupantId 제외 */
export type PublicDevice = Omit<Device, 'occupantId'> & { readonly isOccupied: boolean };

/** 도메인 → 공개 형태 변환 (occupantId 제거) */
export function toPublicDevice(device: Device): PublicDevice {
  const { occupantId, ...rest } = device;
  return { ...rest, isOccupied: occupantId !== null };
}

/** 점유 조건 */
export interface OccupyFilter {
  readonly platform?: DevicePlatform;
  readonly tags?: readonly string[];
  /** 특정 기기 지정 점유 (웹 콘솔용) */
  readonly deviceId?: string;
}

/** 해제 결과 */
export type ReleaseResult = 'released' | 'not_found' | 'not_occupied' | 'forbidden';
