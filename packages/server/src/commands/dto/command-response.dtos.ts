import { ApiProperty } from '@nestjs/swagger';

/**
 * 명령 응답 스키마 — 형태 근거는 Controller(XCUITest 러너)의 실제 JSON:
 * tap/swipe/type/press {ok}, ui {ok,tree}, screenshot {ok,jpegBase64,widthPt,heightPt}
 */

/** 성공만 알리는 액션 결과 (tap/swipe/type/press) */
export class AckResultDto {
  @ApiProperty()
  readonly ok!: boolean;
}

export class AckCommandResponseDto {
  @ApiProperty({ type: AckResultDto })
  readonly result!: AckResultDto;
}

export class UiDumpResultDto {
  @ApiProperty()
  readonly ok!: boolean;

  @ApiProperty({ description: '접근성 트리 텍스트' })
  readonly tree!: string;
}

export class UiDumpCommandResponseDto {
  @ApiProperty({ type: UiDumpResultDto })
  readonly result!: UiDumpResultDto;
}

export class ScreenshotResultDto {
  @ApiProperty()
  readonly ok!: boolean;

  @ApiProperty({ description: 'JPEG 이미지 (base64)' })
  readonly jpegBase64!: string;

  @ApiProperty({ description: '탭 좌표 기준계 폭 — iOS는 pt, Android는 px (Agent가 정규화)' })
  readonly coordWidth!: number;

  @ApiProperty({ description: '탭 좌표 기준계 높이' })
  readonly coordHeight!: number;
}

export class ScreenshotCommandResponseDto {
  @ApiProperty({ type: ScreenshotResultDto })
  readonly result!: ScreenshotResultDto;
}
