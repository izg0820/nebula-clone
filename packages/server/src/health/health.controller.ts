import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthStatusDto } from './dto/health-status.dto';

/** 헬스체크 — 인증 없이 접근 가능 (스펙상으로도 무인증: ApiBearerAuth 미부착) */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @ApiOperation({ summary: '서버 생존 확인' })
  @ApiOkResponse({ type: HealthStatusDto })
  @Public()
  @Get()
  check(): HealthStatusDto {
    return { status: 'ok' };
  }
}
