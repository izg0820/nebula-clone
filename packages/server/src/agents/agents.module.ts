import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { AgentsGateway } from './agents.gateway';

/** Agent WS 터널 모듈 */
@Module({
  imports: [DevicesModule],
  providers: [AgentsGateway],
})
export class AgentsModule {}
