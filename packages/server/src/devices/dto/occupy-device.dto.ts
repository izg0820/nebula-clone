import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { DevicePlatform } from '../device.types';

/** 기기 점유 요청 */
export class OccupyDeviceDto {
  @ApiPropertyOptional({ enum: ['ios', 'android'], description: '플랫폼 필터' })
  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: DevicePlatform;

  @ApiPropertyOptional({ type: [String], description: '기기 태그 필터 (모두 일치)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '특정 기기 지정 점유 (UDID)' })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
