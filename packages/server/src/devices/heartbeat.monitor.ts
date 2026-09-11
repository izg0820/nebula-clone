import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveMsEnv, SWEEP_INTERVAL_MS } from '../config/constants';
import { DevicesService } from './devices.service';

/** 하트비트 만료 기기 오프라인 처리 — 주기는 NEBULA_SWEEP_INTERVAL_MS (기본 30초) */
@Injectable()
export class HeartbeatMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatMonitor.name);
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
      const stale = this.devicesService.expireStaleDevices();
      if (stale.length > 0) {
        this.logger.warn(
          `하트비트 만료로 오프라인 처리: ${stale.map((device) => device.deviceId).join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error('하트비트 스윕 실패', error as Error);
    }
  }
}
