import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** 점유 활동 연장 요청 — 점유 시 발급된 occupantId 필요 */
export class KeepaliveDeviceDto {
  @ApiProperty({ description: '점유 시 발급된 점유자 ID' })
  @IsString()
  @IsNotEmpty()
  occupantId!: string;
}
