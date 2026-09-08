import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolveMsEnv,
  SWEEP_INTERVAL_MS,
  VIEWER_CLOSE_OCCUPATION_EXPIRED,
} from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { StreamsRelayService } from '../streams/streams-relay.service';

/**
 * 유휴 점유 회수 — 주기는 NEBULA_SWEEP_INTERVAL_MS (기본 30초).
 * 회수한 기기의 스트림 시청자도 함께 종료
 */
@Injectable()
export class OccupancyExpiryMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OccupancyExpiryMonitor.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly devicesService: DevicesService,
    private readonly relay: StreamsRelayService,
    config: ConfigService,
  ) {
    this.intervalMs = resolveMsEnv(config.get<string>('NEBULA_SWEEP_INTERVAL_MS'), SWEEP_INTERVAL_MS);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

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
