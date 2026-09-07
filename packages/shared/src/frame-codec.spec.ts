import {
  decodeAgentFrame,
  decodeViewerFrame,
  encodeAgentFrame,
  encodeViewerFrame,
  FRAME_FORMAT_H264,
  FRAME_FORMAT_JPEG,
} from './frame-codec';

const PAYLOAD = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);

describe('frame-codec', () => {
  test('Agent 프레임 인코딩·디코딩 왕복 (H.264 키프레임)', () => {
    const decoded = decodeAgentFrame(
      encodeAgentFrame({
        deviceId: 'udid-한글도-ok',
        format: FRAME_FORMAT_H264,
        isKey: true,
        width: 1290,
        height: 2796,
        payload: PAYLOAD,
      }),
    );

    expect(decoded).toMatchObject({
      deviceId: 'udid-한글도-ok',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 1290,
      height: 2796,
    });
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(PAYLOAD));
  });

  test('시청자 프레임 왕복 (JPEG delta 아님 — 항상 key)', () => {
    const decoded = decodeViewerFrame(
      encodeViewerFrame({
        format: FRAME_FORMAT_JPEG,
        isKey: true,
        width: 430,
        height: 932,
        payload: PAYLOAD,
      }),
    );

    expect(decoded).toMatchObject({ format: FRAME_FORMAT_JPEG, isKey: true, width: 430, height: 932 });
  });

  test('subarray 오프셋이 있어도 정확히 디코딩 (byteOffset 처리)', () => {
    const padded = new Uint8Array([
      0, 0, 0,
      ...encodeViewerFrame({
        format: FRAME_FORMAT_H264,
        isKey: false,
        width: 100,
        height: 200,
        payload: PAYLOAD,
      }),
    ]);

    const decoded = decodeViewerFrame(padded.subarray(3));

    expect(decoded).toMatchObject({ format: FRAME_FORMAT_H264, isKey: false, width: 100, height: 200 });
  });

  test('손상 데이터·미지의 format은 null (throw 금지)', () => {
    expect(decodeAgentFrame(new Uint8Array([]))).toBeNull();
    expect(decodeAgentFrame(new Uint8Array([200, 1, 2]))).toBeNull();
    expect(decodeViewerFrame(new Uint8Array([9, 1, 0, 100, 0, 100, 1]))).toBeNull();
  });

  test('deviceId·크기 범위 초과는 인코딩 시점에 실패', () => {
    expect(() =>
      encodeAgentFrame({
        deviceId: 'a'.repeat(300),
        format: FRAME_FORMAT_JPEG,
        isKey: true,
        width: 1,
        height: 1,
        payload: PAYLOAD,
      }),
    ).toThrow(/deviceId/);
    expect(() =>
      encodeAgentFrame({
        deviceId: 'u1',
        format: FRAME_FORMAT_JPEG,
        isKey: true,
        width: 70_000,
        height: 1,
        payload: PAYLOAD,
      }),
    ).toThrow(/범위/);
  });
});
