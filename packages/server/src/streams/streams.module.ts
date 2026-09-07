import { Module } from '@nestjs/common';
import { StreamsGateway } from './streams.gateway';
import { StreamsRelayService } from './streams-relay.service';

/** 미러링 스트림 릴레이 모듈 — Agent 프레임 → 브라우저 시청자 */
@Module({
  providers: [StreamsRelayService, StreamsGateway],
  exports: [StreamsRelayService],
})
export class StreamsModule {}
