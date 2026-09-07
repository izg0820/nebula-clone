import {
  decodeAgentFrame,
  decodeViewerFrame,
  encodeAgentFrame,
  encodeViewerFrame,
} from './frame-codec';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

describe('frame-codec', () => {
  test('Agent 프레임 인코딩·디코딩 왕복', () => {
    const encoded = encodeAgentFrame({
      deviceId: 'udid-한글도-ok',
      widthPt: 430,
      heightPt: 932,
      jpeg: JPEG,
    });

    const decoded = decodeAgentFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.deviceId).toBe('udid-한글도-ok');
    expect(decoded?.widthPt).toBe(430);
    expect(decoded?.heightPt).toBe(932);
    expect(Array.from(decoded?.jpeg ?? [])).toEqual(Array.from(JPEG));
  });

  test('시청자 프레임 인코딩·디코딩 왕복', () => {
    const decoded = decodeViewerFrame(encodeViewerFrame({ widthPt: 430, heightPt: 932, jpeg: JPEG }));

    expect(decoded?.widthPt).toBe(430);
    expect(decoded?.heightPt).toBe(932);
    expect(Array.from(decoded?.jpeg ?? [])).toEqual(Array.from(JPEG));
  });

  test('subarray 오프셋이 있어도 정확히 디코딩 (byteOffset 처리)', () => {
    const padded = new Uint8Array([
      0, 0, 0,
      ...encodeViewerFrame({ widthPt: 100, heightPt: 200, jpeg: JPEG }),
    ]);

    const decoded = decodeViewerFrame(padded.subarray(3));

    expect(decoded?.widthPt).toBe(100);
    expect(decoded?.heightPt).toBe(200);
  });

  test('손상 데이터는 null (throw 금지)', () => {
    expect(decodeAgentFrame(new Uint8Array([]))).toBeNull();
    expect(decodeAgentFrame(new Uint8Array([200, 1, 2]))).toBeNull();
    expect(decodeViewerFrame(new Uint8Array([0, 1]))).toBeNull();
  });

  test('deviceId 초과·pt 범위 초과는 인코딩 시점에 실패', () => {
    expect(() =>
      encodeAgentFrame({ deviceId: 'a'.repeat(300), widthPt: 1, heightPt: 1, jpeg: JPEG }),
    ).toThrow(/deviceId/);
    expect(() =>
      encodeAgentFrame({ deviceId: 'u1', widthPt: 70_000, heightPt: 1, jpeg: JPEG }),
    ).toThrow(/pt/);
  });
});
