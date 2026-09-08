import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { DeviceCard } from './DeviceCard';
import { PublicDevice } from '@nebula/client';

// 생성 스키마 기준 전체 필드 — 서버 스펙과 어긋나면 여기서 컴파일 실패 (드리프트 검출)
const DEVICE: PublicDevice = {
  id: 'udid-1',
  name: 'iPhone 14 Pro Max',
  platform: 'ios',
  osVersion: '26.0',
  tags: ['controller-ready'],
  status: 'online',
  agentId: 'agent-1',
  occupiedAt: null,
  lastHeartbeatAt: '2026-09-08T00:00:00.000Z',
  lastActivityAt: null,
  isOccupied: false,
};

function renderCard(overrides: Partial<Parameters<typeof DeviceCard>[0]> = {}) {
  return render(
    <DeviceCard
      device={DEVICE}
      isMine={false}
      hasOtherOccupation={false}
      onOccupy={() => undefined}
      onRelease={() => undefined}
      {...overrides}
    />,
  );
}

function occupyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '점유' }) as HTMLButtonElement;
}

describe('DeviceCard', () => {
  // vitest는 globals 미사용 — RTL 자동 cleanup이 안 걸리므로 명시적으로
  afterEach(cleanup);

  test('가용 기기는 점유 버튼 활성', () => {
    renderCard();
    expect(occupyButton().disabled).toBe(false);
  });

  test('다른 기기를 점유 중이면 점유 버튼 비활성 (occupantId 덮어쓰기 방지)', () => {
    renderCard({ hasOtherOccupation: true });
    expect(occupyButton().disabled).toBe(true);
  });

  test('offline·점유된 기기는 점유 불가', () => {
    renderCard({ device: { ...DEVICE, status: 'offline' } });
    expect(occupyButton().disabled).toBe(true);
  });

  test('내 기기는 해제 버튼만 표시', () => {
    renderCard({ isMine: true });
    expect(screen.getByRole('button', { name: '해제' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '점유' })).toBeNull();
  });
});
