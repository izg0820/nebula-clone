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
  /** 마지막 점유 활동 시각 (ISO, 미점유 시 null) — sliding TTL 기준 */
  readonly lastActivityAt: string | null;
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

/** 점유 조작 실패 사유 (해제·연장 공용) */
export type OccupationFailure = 'not_found' | 'not_occupied' | 'forbidden';

/** 해제 결과 */
export type ReleaseResult = 'released' | OccupationFailure;

/** 점유 활동 연장 결과 */
export type RenewResult = 'renewed' | OccupationFailure;

/** 종료된 점유 — 회수 경로가 어느 세대를 끝냈는지 함께 반환 (스트림 접근 회수 기준) */
export interface EndedOccupation {
  readonly deviceId: string;
  readonly occupantId: string;
}

/** 오프라인 처리된 기기 — 점유가 남아 있었다면 회수된 세대도 함께 반환 */
export interface StaleDevice {
  readonly deviceId: string;
  readonly occupantId: string | null;
}
