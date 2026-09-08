import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VIEWER_CLOSE_OCCUPATION_EXPIRED } from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { StreamsRelayService } from '../streams/streams-relay.service';

/** 유휴 점유 회수 (30초 주기) — 회수한 기기의 스트림 시청자도 함께 종료 */
@Injectable()
export class OccupancyExpiryMonitor {
  private readonly logger = new Logger(OccupancyExpiryMonitor.name);

  constructor(
    private readonly devicesService: DevicesService,
    private readonly relay: StreamsRelayService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  sweep(): void {
    try {
      const expiredIds = this.devicesService.expireIdleOccupations();
      if (expiredIds.length === 0) return;
      this.logger.warn(`점유 만료로 회수: ${expiredIds.join(', ')}`);
      for (const deviceId of expiredIds) {
        this.relay.closeViewers(deviceId, VIEWER_CLOSE_OCCUPATION_EXPIRED, 'occupation expired');
      }
    } catch (error) {
      this.logger.error('점유 만료 스윕 실패', error as Error);
    }
  }
}
