import { BadGatewayException } from '@nestjs/common';
import { ScreenshotResultDto, UiDumpResultDto } from './dto/command-response.dtos';

/**
 * Agent→Controller 결과를 스펙에 선언한 형태로 좁힘 — 선언이 참이 되도록 경계에서 검증.
 * 대상은 클라이언트가 필드를 실제로 파싱하는 ui-dump/screenshot 둘로 한정 (tap 계열은 pass-through)
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toUiDumpResult(result: unknown): UiDumpResultDto {
  if (isRecord(result) && typeof result.ok === 'boolean' && typeof result.tree === 'string') {
    return { ok: result.ok, tree: result.tree };
  }
  throw new BadGatewayException('기기 UI 덤프 응답 형식 오류 (tree 누락)');
}

export function toScreenshotResult(result: unknown): ScreenshotResultDto {
  if (
    isRecord(result) &&
    typeof result.ok === 'boolean' &&
    typeof result.jpegBase64 === 'string' &&
    typeof result.coordWidth === 'number' &&
    typeof result.coordHeight === 'number'
  ) {
    return {
      ok: result.ok,
      jpegBase64: result.jpegBase64,
      coordWidth: result.coordWidth,
      coordHeight: result.coordHeight,
    };
  }
  throw new BadGatewayException('기기 스크린샷 응답 형식 오류 (jpegBase64/coord 크기 누락)');
}
