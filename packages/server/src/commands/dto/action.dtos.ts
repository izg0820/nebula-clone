import { HardwareButton } from '@nebula/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** 좌표 상한 — 비정상 값 조기 차단 (현행 기기 해상도 여유 포함) */
const MAX_COORDINATE = 10_000;
const MAX_TEXT_LENGTH = 4_000;
/** Agent→Controller HTTP 타임아웃(10초)보다 확실히 낮게 — 상한 스와이프가 항상 타임아웃되는 것 방지 */
const MAX_SWIPE_DURATION_MS = 5_000;

/** 모든 명령 공통 — 점유 시 발급된 occupantId 필요 */
export class CommandBaseDto {
  @ApiProperty({ description: '점유 시 발급된 점유자 ID' })
  @IsString()
  @IsNotEmpty()
  occupantId!: string;
}

export class TapDto extends CommandBaseDto {
  @ApiProperty({ description: 'x 좌표 (pt)' })
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  x!: number;

  @ApiProperty({ description: 'y 좌표 (pt)' })
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  y!: number;
}

export class SwipeDto extends CommandBaseDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  fromX!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  fromY!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  toX!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(MAX_COORDINATE)
  toY!: number;

  @ApiPropertyOptional({ description: '스와이프 시간 (ms, 기본 300)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SWIPE_DURATION_MS)
  durationMs?: number;
}

export class TypeTextDto extends CommandBaseDto {
  @ApiProperty({ description: '입력할 텍스트 (한글·이모지 지원은 Controller 구현에 따름)' })
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  text!: string;
}

export class UiDumpDto extends CommandBaseDto {}

export class PressButtonDto extends CommandBaseDto {
  @ApiProperty({ enum: ['home', 'back'], description: '하드웨어 버튼 — back은 Android 전용' })
  @IsIn(['home', 'back'])
  button!: HardwareButton;
}
