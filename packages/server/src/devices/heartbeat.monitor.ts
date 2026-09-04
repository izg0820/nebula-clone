import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DevicesService } from './devices.service';

/** 하트비트 만료 기기 오프라인 처리 (30초 주기) */
@Injectable()
export class HeartbeatMonitor {
  private readonly logger = new Logger(HeartbeatMonitor.name);

  constructor(private readonly devicesService: DevicesService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  sweep(): void {
    try {
      const staleIds = this.devicesService.expireStaleDevices();
      if (staleIds.length > 0) {
        this.logger.warn(`하트비트 만료로 오프라인 처리: ${staleIds.join(', ')}`);
      }
    } catch (error) {
      this.logger.error('하트비트 스윕 실패', error as Error);
    }
  }
}
