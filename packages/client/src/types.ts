import { components } from './generated/api-schema';

/**
 * 생성 스키마 → 도메인 친화 별칭 — 소비자가 components['schemas'][...]를 몰라도 되고,
 * 스펙 스키마명이 바뀌면 이 파일 한 곳만 고침
 */
type Schemas = components['schemas'];

export type PublicDevice = Schemas['PublicDeviceDto'];
export type OccupyResponse = Schemas['OccupyResponseDto'];
export type KeepaliveResponse = Schemas['KeepaliveResponseDto'];
export type ScreenshotResult = Schemas['ScreenshotResultDto'];
export type UiDumpResult = Schemas['UiDumpResultDto'];
export type HealthStatus = Schemas['HealthStatusDto'];
export type OccupyRequest = Schemas['OccupyDeviceDto'];

export type DevicePlatform = PublicDevice['platform'];
export type HardwareButton = Schemas['PressButtonDto']['button'];

/** 점유한 기기 대상 지정 — 모든 조작 API의 공통 인자 */
export interface DeviceTarget {
  readonly deviceId: string;
  readonly occupantId: string;
}

export interface TapPoint {
  readonly x: number;
  readonly y: number;
}

export interface SwipeGesture {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs?: number;
}
