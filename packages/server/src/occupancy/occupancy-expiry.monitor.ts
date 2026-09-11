import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveMsEnv, SWEEP_INTERVAL_MS } from '../config/constants';
import { DevicesService } from '../devices/devices.service';

/**
 * 유휴 점유 회수 — 주기는 NEBULA_SWEEP_INTERVAL_MS (기본 30초).
 * 회수한 기기의 스트림 시청자 종료는 StreamRevocationListener가 담당
 * (해제·유휴 만료·하트비트 회수가 같은 점유 종료 이벤트로 수렴)
 */
@Injectable()
export class OccupancyExpiryMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OccupancyExpiryMonitor.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly devicesService: DevicesService,
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
      const expired = this.devicesService.expireIdleOccupations();
      if (expired.length === 0) return;
      this.logger.warn(`점유 만료로 회수: ${expired.map((item) => item.deviceId).join(', ')}`);
    } catch (error) {
      this.logger.error('점유 만료 스윕 실패', error as Error);
    }
  }
}
