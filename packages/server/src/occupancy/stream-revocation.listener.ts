import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { VIEWER_CLOSE_OCCUPATION_ENDED } from '../config/constants';
import {
  OccupancyEvents,
  OccupationEndReason,
  OccupationEndedEvent,
} from '../devices/occupancy-events.service';
import { StreamsRelayService } from '../streams/streams-relay.service';

/** 종료 사유 → 시청자에게 전달할 close reason */
const CLOSE_REASONS: Record<OccupationEndReason, string> = {
  released: 'occupation released',
  idle_expired: 'occupation expired',
  agent_stale: 'device offline',
};

/**
 * 점유 종료 → 스트림 접근 회수
 *
 * 점유가 끝나는 모든 경로(명시 해제·유휴 만료·하트비트 회수)가 이 한 곳으로 수렴.
 * 소켓 정리를 클라이언트에 맡기면 인가가 아니므로, 서버가 끝난 세대의 시청자를 직접 끊는다
 */
@Injectable()
export class StreamRevocationListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StreamRevocationListener.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly occupancyEvents: OccupancyEvents,
    private readonly relay: StreamsRelayService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.occupancyEvents.onEnded((event) => this.revoke(event));
  }

  onApplicationShutdown(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  private revoke(event: OccupationEndedEvent): void {
    this.logger.log(`점유 종료로 스트림 회수 (device=${event.deviceId}, reason=${event.reason})`);
    this.relay.closeViewers(
      event.deviceId,
      event.occupantId,
      VIEWER_CLOSE_OCCUPATION_ENDED,
      CLOSE_REASONS[event.reason],
    );
  }
}
