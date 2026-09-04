import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

/** 헬스체크 — 인증 없이 접근 가능 */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
