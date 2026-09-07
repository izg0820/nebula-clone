import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { StreamsModule } from '../streams/streams.module';
import { AgentsGateway } from './agents.gateway';

/** Agent WS 터널 모듈 */
@Module({
  imports: [DevicesModule, StreamsModule],
  providers: [AgentsGateway],
  exports: [AgentsGateway],
})
export class AgentsModule {}
