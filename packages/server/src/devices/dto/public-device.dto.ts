import { ApiProperty } from '@nestjs/swagger';
import { DevicePlatform, DeviceStatus, PublicDevice } from '../device.types';

/**
 * 공개 기기 응답 스키마 — implements가 도메인 PublicDevice와의 필드 누락·타입 불일치를
 * 컴파일에서 잡음. occupantId 유입(추가 필드)은 OpenAPI 스펙 테스트가 별도로 검증 (2중 방어)
 */
export class PublicDeviceDto implements PublicDevice {
  @ApiProperty({ description: '기기 UDID' })
  readonly id!: string;

  @ApiProperty({ description: '기기 이름' })
  readonly name!: string;

  @ApiProperty({ enum: ['ios'] })
  readonly platform!: DevicePlatform;

  @ApiProperty()
  readonly osVersion!: string;

  @ApiProperty({ type: [String], description: '기기 태그 (controller-ready 등)' })
  readonly tags!: readonly string[];

  @ApiProperty({ enum: ['online', 'offline'] })
  readonly status!: DeviceStatus;

  @ApiProperty({ type: String, nullable: true, description: '관리 Agent ID (오프라인 시 null)' })
  readonly agentId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: '점유 시각' })
  readonly occupiedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  readonly lastHeartbeatAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: '마지막 점유 활동 시각 (sliding TTL 기준)',
  })
  readonly lastActivityAt!: string | null;

  @ApiProperty({ description: '점유 중 여부 (occupantId는 응답에 포함하지 않음)' })
  readonly isOccupied!: boolean;
}
