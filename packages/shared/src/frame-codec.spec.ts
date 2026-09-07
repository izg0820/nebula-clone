import {
  decodeAgentFrame,
  decodeViewerFrame,
  encodeAgentFrame,
  encodeViewerFrame,
  FRAME_FORMAT_H264,
} from './frame-codec';

const PAYLOAD = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);

describe('frame-codec', () => {
  test('Agent 프레임 인코딩·디코딩 왕복 (키프레임)', () => {
    const decoded = decodeAgentFrame(
      encodeAgentFrame({
        deviceId: '00008120-000C.udid_OK',
        format: FRAME_FORMAT_H264,
        isKey: true,
        width: 1290,
        height: 2796,
        stampMs: 123456789,
        payload: PAYLOAD,
      }),
    );

    expect(decoded).toMatchObject({
      deviceId: '00008120-000C.udid_OK',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 1290,
      height: 2796,
      stampMs: 123456789,
    });
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(PAYLOAD));
  });

  test('시청자 프레임 왕복 (delta 프레임)', () => {
    const decoded = decodeViewerFrame(
      encodeViewerFrame({
        format: FRAME_FORMAT_H264,
        isKey: false,
        width: 644,
        height: 1398,
        stampMs: 42,
        payload: PAYLOAD,
      }),
    );

    expect(decoded).toMatchObject({
      format: FRAME_FORMAT_H264,
      isKey: false,
      width: 644,
      height: 1398,
      stampMs: 42,
    });
  });

  test('subarray 오프셋이 있어도 정확히 디코딩 (byteOffset 처리)', () => {
    const padded = new Uint8Array([
      0, 0, 0,
      ...encodeViewerFrame({
        format: FRAME_FORMAT_H264,
        isKey: false,
        width: 100,
        height: 200,
        stampMs: 7,
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
    // 폐기된 JPEG format(1)도 거부
    expect(decodeViewerFrame(new Uint8Array([1, 1, 0, 100, 0, 100, 0, 0, 0, 0, 0xff]))).toBeNull();
  });

  test('치수 0·비정수는 인코딩 시점에 실패, 디코딩은 null (디코더 configure throw 방지)', () => {
    const base = {
      format: FRAME_FORMAT_H264,
      isKey: true,
      stampMs: 0,
      payload: PAYLOAD,
    } as const;

    expect(() => encodeViewerFrame({ ...base, width: 0, height: 100 })).toThrow(/범위|비정수/);
    expect(() => encodeViewerFrame({ ...base, width: 100.5, height: 100 })).toThrow(/범위|비정수/);

    // 폭 0이 기록된 원시 바이트 — 디코더는 거부해야 함
    const zeroWidth = new Uint8Array([2, 1, 0, 0, 0, 100, 0, 0, 0, 0, 0xff]);
    expect(decodeViewerFrame(zeroWidth)).toBeNull();
  });

  test('허용 형식 밖 deviceId(경로 구분자 등)는 디코딩 시 null', () => {
    // 패턴 검증은 디코드 경계에서 — 인코더(자체 Agent)는 형식을 지키는 전제
    const withSlash = encodeViewerFrame({
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 10,
      height: 10,
      stampMs: 0,
      payload: PAYLOAD,
    });
    // Agent 프레임 수동 조립: idLen=3, id="../"
    const malicious = new Uint8Array(1 + 3 + 10 + 1);
    malicious[0] = 3;
    malicious.set(new TextEncoder().encode('../'), 1);
    malicious[4] = FRAME_FORMAT_H264;
    malicious[5] = 1;
    new DataView(malicious.buffer).setUint16(6, 10);
    new DataView(malicious.buffer).setUint16(8, 10);
    expect(decodeAgentFrame(malicious)).toBeNull();
    expect(decodeViewerFrame(withSlash)).not.toBeNull();
  });

  test('deviceId·크기 범위 초과는 인코딩 시점에 실패', () => {
    expect(() =>
      encodeAgentFrame({
        deviceId: 'a'.repeat(300),
        format: FRAME_FORMAT_H264,
        isKey: true,
        width: 1,
        height: 1,
        stampMs: 0,
        payload: PAYLOAD,
      }),
    ).toThrow(/deviceId/);
    expect(() =>
      encodeAgentFrame({
        deviceId: 'u1',
        format: FRAME_FORMAT_H264,
        isKey: true,
        width: 70_000,
        height: 1,
        stampMs: 0,
        payload: PAYLOAD,
      }),
    ).toThrow(/범위/);
  });
});
