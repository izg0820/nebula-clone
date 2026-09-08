import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Nest HttpException 기본 응답 형태 — ValidationPipe 실패는 message가 string[] */
export class ErrorResponseDto {
  @ApiProperty({ example: 404 })
  readonly statusCode!: number;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  readonly message!: string | string[];

  @ApiPropertyOptional({ example: 'Not Found' })
  readonly error?: string;
}
