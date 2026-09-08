import { useEffect } from 'react';
import { ApiError, NebulaClient } from '@nebula/client';

/** 점유 세션 (App과 동일 형태 — 순환 import 방지용 로컬 선언) */
export interface KeepaliveOccupation {
  readonly deviceId: string;
  readonly occupantId: string;
}

/** 서버 TTL(기본 10분)의 1/20 — 백그라운드 탭 타이머 스로틀(1분)에도 여유 */
export const OCCUPATION_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * 사용자 입력이 이 시간 없으면 keepalive 중단 — 방치된 탭이 점유를 영구화하면
 * TTL이 고치려던 버그와 동형. 중단 후엔 서버 TTL(10분)이 자연 회수 → 4408/409로 세션 정리
 */
export const KEEPALIVE_IDLE_LIMIT_MS = 30 * 60_000;

/** 사람 활동으로 치는 입력 — 시청만(입력 없음)은 30분 후 회수 대상 (문서화된 트레이드오프) */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/** keepalive에서 점유 무효로 확정되는 코드 — 403(불일치)·404(기기 없음)·409(만료 회수 후 미점유) */
const OCCUPATION_LOST_STATUSES = new Set([403, 404, 409]);

/**
 * 점유 sliding TTL 유지 — 주기적으로 keepalive를 보내되, 사용자 입력이
 * KEEPALIVE_IDLE_LIMIT_MS 동안 없으면 중단해 서버가 회수할 수 있게 한다.
 * 점유 무효(403/404/409)만 세션을 정리하고, 일시 오류(네트워크·5xx)는 세션 유지 —
 * occupantId를 버리면 해제 수단이 사라지는 기존 규칙(handleRelease)과 동일.
 * onOccupationLost는 안정 identity 필수 (App의 useCallback 전제)
 */
export function useOccupationKeepalive(
  api: NebulaClient,
  occupation: KeepaliveOccupation | null,
  onOccupationLost: () => void,
  onStatus: (message: string) => void,
): void {
  useEffect(() => {
    if (!occupation) return;
    let isActive = true;
    // 점유 시점을 첫 활동으로 간주 — 점유 직후 입력 없이도 유휴 상한까지는 유지
    let lastActivityAt = Date.now();
    let hasWarnedIdle = false;

    function recordActivity(): void {
      lastActivityAt = Date.now();
      hasWarnedIdle = false;
    }
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, recordActivity, { passive: true });
    }

    async function sendKeepalive(): Promise<void> {
      if (!occupation) return;
      if (Date.now() - lastActivityAt > KEEPALIVE_IDLE_LIMIT_MS) {
        // 연장 중단 — 서버 TTL이 회수하면 스트림 4408·다음 요청 409가 세션을 정리함
        if (!hasWarnedIdle) {
          hasWarnedIdle = true;
          onStatus('입력이 없어 점유 자동 연장을 중단했습니다 — 곧 만료됩니다 (입력 시 재개)');
        }
        return;
      }
      try {
        await api.keepalive(occupation.deviceId, occupation.occupantId);
      } catch (error) {
        if (!isActive) return;
        if (error instanceof ApiError && OCCUPATION_LOST_STATUSES.has(error.status)) {
          onOccupationLost();
          onStatus('점유가 만료되어 해제됐습니다 — 다시 점유해주세요');
        }
        // 그 외(네트워크·5xx·타임아웃)는 다음 주기에 재시도 — 세션 유지
      }
    }

    // 점유 직후에는 서버가 이미 갱신했으므로 즉시 호출 없이 주기만
    const timer = setInterval(() => void sendKeepalive(), OCCUPATION_KEEPALIVE_INTERVAL_MS);
    return () => {
      isActive = false;
      clearInterval(timer);
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, recordActivity);
      }
    };
  }, [api, occupation, onOccupationLost, onStatus]);
}
