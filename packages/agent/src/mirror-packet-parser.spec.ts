import { MirrorPacketParser } from './mirror-packet-parser';

/**
 * 바이트 픽스처는 android-controller/mirror MirrorProtocolTest.kt와 동일 — 양단 교차 검증.
 * 여기 기대값을 바꾸면 반드시 Kotlin 쪽도 함께 바꿀 것
 */
const PREAMBLE_1248x1972 = Buffer.from([
  0x4e, 0x42, 0x4c, 0x41, // 'NBLA'
  0x00, 0x01, // ver=1
  0x01, // codec=h264
  0x00, // rsv
  0x04, 0xe0, // w=1248
  0x07, 0xb4, // h=1972
  0x00, 0x00, 0x00, 0x00, // rsv
]);

function packet(isKey: boolean, ptsMs: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(14);
  header[0] = isKey ? 0x01 : 0x00;
  header.writeUInt16BE(1248, 2);
  header.writeUInt16BE(1972, 4);
  header.writeUInt32BE(ptsMs, 6);
  header.writeUInt32BE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

describe('MirrorPacketParser', () => {
  test('프리앰블 + 키프레임 패킷 파싱 (Kotlin 픽스처 동일)', () => {
    const parser = new MirrorPacketParser();
    const payload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]); // SPS 시작 (인밴드)
    const keyPacket = Buffer.concat([
      Buffer.from([
        0x01, 0x00, // flags: key, rsv
        0x04, 0xe0, 0x07, 0xb4, // 1248x1972
        0x01, 0x02, 0x03, 0x04, // ptsMs=0x01020304
        0x00, 0x00, 0x00, 0x05, // len=5
      ]),
      payload,
    ]);

    const packets = parser.push(Buffer.concat([PREAMBLE_1248x1972, keyPacket]));

    expect(parser.preamble).toEqual({ width: 1248, height: 1972 });
    expect(packets).toHaveLength(1);
    expect(packets![0]).toMatchObject({
      isKey: true,
      width: 1248,
      height: 1972,
      ptsMs: 0x01020304,
    });
    expect([...packets![0].payload]).toEqual([...payload]);
  });

  test('청크 경계 분할 수신 — 바이트 단위로 흘려도 온전히 조립', () => {
    const parser = new MirrorPacketParser();
    const stream = Buffer.concat([
      PREAMBLE_1248x1972,
      packet(false, 100, Buffer.from([0xaa, 0xbb])),
      packet(true, 200, Buffer.from([0xcc])),
    ]);

    const collected: unknown[] = [];
    for (const byte of stream) {
      const packets = parser.push(Buffer.from([byte]));
      expect(packets).not.toBeNull();
      collected.push(...packets!);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ isKey: false, ptsMs: 100 });
    expect(collected[1]).toMatchObject({ isKey: true, ptsMs: 200 });
  });

  test('매직 불일치는 즉시 poison — 이후 수신 무시', () => {
    const parser = new MirrorPacketParser();
    const bad = Buffer.from(PREAMBLE_1248x1972);
    bad[0] = 0x58;

    expect(parser.push(bad)).toBeNull();
    expect(parser.push(PREAMBLE_1248x1972)).toBeNull();
  });

  test('버전·코덱 불일치는 poison', () => {
    const wrongVersion = Buffer.from(PREAMBLE_1248x1972);
    wrongVersion[5] = 0x02;
    expect(new MirrorPacketParser().push(wrongVersion)).toBeNull();

    const wrongCodec = Buffer.from(PREAMBLE_1248x1972);
    wrongCodec[6] = 0x09;
    expect(new MirrorPacketParser().push(wrongCodec)).toBeNull();
  });

  test('패킷 길이 폭주는 poison (8MB 상한)', () => {
    const parser = new MirrorPacketParser();
    expect(parser.push(PREAMBLE_1248x1972)).toEqual([]);

    const huge = packet(false, 0, Buffer.from([0x00]));
    huge.writeUInt32BE(9 * 1024 * 1024, 10);
    expect(parser.push(huge)).toBeNull();
  });

  test('해상도 변경 — 패킷별 크기가 그대로 반영 (파서 상태 없음)', () => {
    const parser = new MirrorPacketParser();
    parser.push(PREAMBLE_1248x1972);

    const unfolded = Buffer.alloc(14 + 1);
    unfolded[0] = 0x01;
    unfolded.writeUInt16BE(2448, 2);
    unfolded.writeUInt16BE(1848, 4);
    unfolded.writeUInt32BE(0, 6);
    unfolded.writeUInt32BE(1, 10);
    unfolded[14] = 0xff;

    const packets = parser.push(unfolded);
    expect(packets).toHaveLength(1);
    expect(packets![0]).toMatchObject({ width: 2448, height: 1848 });
  });
});
