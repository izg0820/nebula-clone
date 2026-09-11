import { DevicePlatform } from './types';

/** 플랫폼 표시 라벨 — 웹 카드·CLI 목록 공용 (하드코딩 'iOS' 제거) */
const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  ios: 'iOS',
  android: 'Android',
};

export function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABELS[platform] ?? platform;
}
