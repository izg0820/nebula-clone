import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentsModule } from './agents/agents.module';
import { CommandsModule } from './commands/commands.module';
import { TokenGuard } from './auth/token.guard';
import { RATE_LIMIT_PER_MINUTE } from './config/constants';
import { validateEnv } from './config/env.validation';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // 무차별 토큰 대입 완화 — IP당 분당 RATE_LIMIT_PER_MINUTE회
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: RATE_LIMIT_PER_MINUTE }]),
    ScheduleModule.forRoot(),
    StorageModule,
    DevicesModule,
    AgentsModule,
    CommandsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: TokenGuard },
  ],
})
export class AppModule {}
