import { ApiProperty } from '@nestjs/swagger';

/** 헬스체크 응답 */
export class HealthStatusDto {
  @ApiProperty({ enum: ['ok'] })
  readonly status!: 'ok';
}
