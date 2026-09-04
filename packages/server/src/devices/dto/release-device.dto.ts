import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** 기기 해제 요청 — 점유 시 발급된 occupantId 필요 */
export class ReleaseDeviceDto {
  @ApiProperty({ description: '점유 시 발급된 점유자 ID' })
  @IsString()
  @IsNotEmpty()
  occupantId!: string;
}
