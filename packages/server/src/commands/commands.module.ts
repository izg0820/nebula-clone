import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { DevicesModule } from '../devices/devices.module';
import { CommandsController } from './commands.controller';
import { CommandsService } from './commands.service';

/** 기기 조작 명령 모듈 — Devices(점유 검증) + Agents(터널 전송) 조합 */
@Module({
  imports: [DevicesModule, AgentsModule],
  controllers: [CommandsController],
  providers: [CommandsService],
})
export class CommandsModule {}
