import { ApiProperty } from '@nestjs/swagger';
import { PublicDeviceDto } from './public-device.dto';

/** 점유 응답 — occupantId(해제 권한 비밀값)는 이 응답에서만 발급 */
export class OccupyResponseDto {
  @ApiProperty({ description: '점유자 ID — 해제·명령·keepalive에 필요한 비밀값' })
  readonly occupantId!: string;

  @ApiProperty({ type: PublicDeviceDto })
  readonly device!: PublicDeviceDto;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: '점유 만료 예정 시각 — 명령·keepalive 활동 시 연장',
  })
  readonly expiresAt!: string | null;
}

/** 점유 유지 응답 — occupantId 미포함 (은닉 불변식) */
export class KeepaliveResponseDto {
  @ApiProperty({ type: PublicDeviceDto })
  readonly device!: PublicDeviceDto;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  readonly expiresAt!: string | null;
}
