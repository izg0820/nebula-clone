import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ApiError, NebulaClient } from '@nebula/client';
import {
  KEEPALIVE_IDLE_LIMIT_MS,
  OCCUPATION_KEEPALIVE_INTERVAL_MS,
  useOccupationKeepalive,
} from './useOccupationKeepalive';

const OCCUPATION = { deviceId: 'udid-1', occupantId: 'occ-1' };

function createApi(keepalive: ReturnType<typeof vi.fn>): NebulaClient {
  return { keepalive } as unknown as NebulaClient;
}

/** 대기 중 마이크로태스크(keepalive의 await) 소진 — fake timer 진행 후 결과 반영용 */
async function flushAsync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('useOccupationKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('주기마다 keepalive 호출 (즉시 호출은 없음 — 점유 직후 서버가 이미 갱신)', async () => {
    const keepalive = vi.fn().mockResolvedValue({});
    renderHook(() =>
      useOccupationKeepalive(createApi(keepalive), OCCUPATION, vi.fn(), vi.fn()),
    );

    expect(keepalive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    expect(keepalive).toHaveBeenCalledTimes(1);
    expect(keepalive).toHaveBeenCalledWith('udid-1', 'occ-1');
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    expect(keepalive).toHaveBeenCalledTimes(2);
  });

  test('점유 없으면 호출하지 않음', async () => {
    const keepalive = vi.fn().mockResolvedValue({});
    renderHook(() => useOccupationKeepalive(createApi(keepalive), null, vi.fn(), vi.fn()));

    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS * 3);
    expect(keepalive).not.toHaveBeenCalled();
  });

  test('403/404는 세션 정리 + 안내', async () => {
    const keepalive = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    const onLost = vi.fn();
    const onStatus = vi.fn();
    renderHook(() => useOccupationKeepalive(createApi(keepalive), OCCUPATION, onLost, onStatus));

    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    await flushAsync();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('만료'));
  });

  test('409(만료 회수 후 미점유)도 세션 정리 — 스트림 없는 클라이언트의 유일한 만료 감지 경로', async () => {
    const keepalive = vi.fn().mockRejectedValue(new ApiError(409, 'not occupied'));
    const onLost = vi.fn();
    renderHook(() => useOccupationKeepalive(createApi(keepalive), OCCUPATION, onLost, vi.fn()));

    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    await flushAsync();

    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test('일시 오류(네트워크·5xx)는 세션 유지 — occupantId를 버리면 해제 수단 상실', async () => {
    const keepalive = vi.fn().mockRejectedValue(new Error('network down'));
    const onLost = vi.fn();
    renderHook(() => useOccupationKeepalive(createApi(keepalive), OCCUPATION, onLost, vi.fn()));

    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    await flushAsync();

    expect(onLost).not.toHaveBeenCalled();
    // 다음 주기에 재시도
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    expect(keepalive).toHaveBeenCalledTimes(2);
  });

  test('유휴 상한 초과 시 keepalive 중단 — 방치 탭이 점유를 영구화하지 않음', async () => {
    const keepalive = vi.fn().mockResolvedValue({});
    const onStatus = vi.fn();
    renderHook(() =>
      useOccupationKeepalive(createApi(keepalive), OCCUPATION, vi.fn(), onStatus),
    );

    // 유휴 상한 직전까지는 정상 연장
    await vi.advanceTimersByTimeAsync(KEEPALIVE_IDLE_LIMIT_MS - OCCUPATION_KEEPALIVE_INTERVAL_MS);
    const callsBeforeIdle = keepalive.mock.calls.length;
    expect(callsBeforeIdle).toBeGreaterThan(0);

    // 상한 초과 후엔 호출 중단 + 안내 1회만 (정확히 상한 시각의 tick 1회까지는 전송 — '초과' 판정)
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS * 10);
    expect(keepalive.mock.calls.length).toBe(callsBeforeIdle + 1);
    const idleNotices = onStatus.mock.calls.filter(([message]) =>
      String(message).includes('자동 연장을 중단'),
    );
    expect(idleNotices).toHaveLength(1);
  });

  test('사용자 입력이 있으면 유휴가 리셋되어 keepalive 재개', async () => {
    const keepalive = vi.fn().mockResolvedValue({});
    renderHook(() =>
      useOccupationKeepalive(createApi(keepalive), OCCUPATION, vi.fn(), vi.fn()),
    );

    // 유휴 상한 초과 → 중단 상태
    await vi.advanceTimersByTimeAsync(KEEPALIVE_IDLE_LIMIT_MS + OCCUPATION_KEEPALIVE_INTERVAL_MS * 2);
    const stalled = keepalive.mock.calls.length;

    // 입력 발생 → 다음 주기부터 재개
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS);
    expect(keepalive.mock.calls.length).toBeGreaterThan(stalled);
  });

  test('언마운트 시 타이머 정리 — 추가 호출 없음', async () => {
    const keepalive = vi.fn().mockResolvedValue({});
    const { unmount } = renderHook(() =>
      useOccupationKeepalive(createApi(keepalive), OCCUPATION, vi.fn(), vi.fn()),
    );

    unmount();
    await vi.advanceTimersByTimeAsync(OCCUPATION_KEEPALIVE_INTERVAL_MS * 3);
    expect(keepalive).not.toHaveBeenCalled();
  });
});
