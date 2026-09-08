import { BadGatewayException } from '@nestjs/common';
import { toScreenshotResult, toUiDumpResult } from './command-result.guards';

describe('command-result.guards', () => {
  test('toUiDumpResult: 정상 형태는 그대로 좁힘', () => {
    expect(toUiDumpResult({ ok: true, tree: 'Application ...' })).toEqual({
      ok: true,
      tree: 'Application ...',
    });
  });

  test('toUiDumpResult: tree 누락·타입 불일치·null은 502', () => {
    expect(() => toUiDumpResult({ ok: true })).toThrow(BadGatewayException);
    expect(() => toUiDumpResult({ ok: true, tree: 42 })).toThrow(BadGatewayException);
    expect(() => toUiDumpResult(null)).toThrow(BadGatewayException);
    expect(() => toUiDumpResult('tree')).toThrow(BadGatewayException);
  });

  test('toScreenshotResult: 정상 형태는 그대로 좁힘', () => {
    const result = { ok: true, jpegBase64: 'abc=', widthPt: 430, heightPt: 932 };
    expect(toScreenshotResult(result)).toEqual(result);
  });

  test('toScreenshotResult: 필드 누락·타입 불일치는 502', () => {
    expect(() => toScreenshotResult({ ok: true, jpegBase64: 'abc=' })).toThrow(
      BadGatewayException,
    );
    expect(() =>
      toScreenshotResult({ ok: true, jpegBase64: 'abc=', widthPt: '430', heightPt: 932 }),
    ).toThrow(BadGatewayException);
    expect(() => toScreenshotResult(undefined)).toThrow(BadGatewayException);
  });
});
