import { Injectable, Logger } from '@nestjs/common';

/** 점유 종료 사유 — 명시 해제 / 유휴 만료 / 하트비트 만료 회수 */
export type OccupationEndReason = 'released' | 'idle_expired' | 'agent_stale';

/** 점유 종료 사실 — occupantId는 끝난 점유 세대 식별자 */
export interface OccupationEndedEvent {
  readonly deviceId: string;
  readonly occupantId: string;
  readonly reason: OccupationEndReason;
}

export type OccupationEndedListener = (event: OccupationEndedEvent) => void;

/**
 * 점유 종료 이벤트 버스 — 동기 발행
 *
 * Devices가 Streams를 직접 부르면 순환(Streams → Devices 의존이 이미 있음)이라,
 * 종료 사실만 여기로 알리고 스트림 접근 회수는 양쪽을 import하는 조립 모듈
 * (OccupancyModule)이 구독해서 수행. 해제·유휴 만료·하트비트 회수 세 경로가
 * 같은 이벤트로 수렴하므로 "점유는 끝났는데 스트림은 살아 있음"이 구조적으로 불가
 */
@Injectable()
export class OccupancyEvents {
  private readonly logger = new Logger(OccupancyEvents.name);
  private readonly listeners = new Set<OccupationEndedListener>();

  /** 구독 — 반환된 함수 호출로 해지 */
  onEnded(listener: OccupationEndedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 종료 발행 — 구독자 실패가 점유 종료 자체를 되돌리지 않도록 격리 (로그는 남김) */
  publishEnded(event: OccupationEndedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `점유 종료 구독자 실패 (device=${event.deviceId}, reason=${event.reason})`,
          error as Error,
        );
      }
    }
  }
}
