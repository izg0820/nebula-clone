import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DEVICES_REPOSITORY } from './devices.repository';
import { DevicesService } from './devices.service';
import { HeartbeatMonitor } from './heartbeat.monitor';
import { SqliteDevicesRepository } from './sqlite-devices.repository';

/** 디바이스 레지스트리·점유 모듈 */
@Module({
  controllers: [DevicesController],
  providers: [
    DevicesService,
    HeartbeatMonitor,
    { provide: DEVICES_REPOSITORY, useClass: SqliteDevicesRepository },
  ],
  // Repository는 이 모듈 내부에서만 접근 — 외부 모듈은 Service 경유 (모듈 소유권 분리)
  exports: [DevicesService],
})
export class DevicesModule {}
