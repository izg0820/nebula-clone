import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { StreamsModule } from '../streams/streams.module';
import { OccupancyExpiryMonitor } from './occupancy-expiry.monitor';
import { StreamRevocationListener } from './stream-revocation.listener';

/**
 * 점유 종료 조립 모듈 — Devices(회수)와 Streams(시청자 종료)를 배선.
 * Streams → Devices 의존이 이미 있어 Devices 쪽에서 Streams를 부르면 순환 —
 * CommandsModule과 같은 "양쪽을 import하는 조립 모듈" 패턴으로 회피
 */
@Module({
  imports: [DevicesModule, StreamsModule],
  providers: [OccupancyExpiryMonitor, StreamRevocationListener],
})
export class OccupancyModule {}
