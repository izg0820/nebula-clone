import { HelperPacketParser } from './h264-stream';

/** [u32BE len][u8 isKey][payload] 패킷 조립 */
function buildPacket(isKey: boolean, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(Number(isKey), 4);
  return Buffer.concat([header, payload]);
}

describe('HelperPacketParser', () => {
  test('한 청크에 여러 패킷 — 전부 순서대로 반환', () => {
    const parser = new HelperPacketParser();
    const first = buildPacket(true, Buffer.from([0x01, 0x02]));
    const second = buildPacket(false, Buffer.from([0x03]));

    const packets = parser.push(Buffer.concat([first, second]));

    expect(packets).toHaveLength(2);
    expect(packets?.[0]).toMatchObject({ isKey: true });
    expect(Array.from(packets?.[0].payload ?? [])).toEqual([0x01, 0x02]);
    expect(packets?.[1]).toMatchObject({ isKey: false });
  });

  test('헤더가 바이트 단위로 분할 도착해도 조립', () => {
    const parser = new HelperPacketParser();
    const packet = buildPacket(true, Buffer.from([0xaa, 0xbb, 0xcc]));

    const collected: Array<{ isKey: boolean; payload: Buffer }> = [];
    for (const byte of packet) {
      const packets = parser.push(Buffer.from([byte]));
      expect(packets).not.toBeNull();
      collected.push(...(packets ?? []));
    }

    expect(collected).toHaveLength(1);
    expect(Array.from(collected[0].payload)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  test('페이로드가 경계에 정확히 걸친 청크 — 미완성분은 다음 push에서 완성', () => {
    const parser = new HelperPacketParser();
    const packet = buildPacket(false, Buffer.from([1, 2, 3, 4]));
    const splitAt = 7; // 헤더 5 + 페이로드 2바이트

    expect(parser.push(packet.subarray(0, splitAt))).toHaveLength(0);
    const packets = parser.push(packet.subarray(splitAt));

    expect(packets).toHaveLength(1);
    expect(Array.from(packets?.[0].payload ?? [])).toEqual([1, 2, 3, 4]);
  });

  test('길이 0 패킷은 손상 — null 반환 (스트림 재시작 신호)', () => {
    const parser = new HelperPacketParser();
    expect(parser.push(buildPacket(true, Buffer.alloc(0)))).toBeNull();
  });

  test('상한(8MB) 초과 길이는 손상 — null 반환 (메모리 폭주 방지)', () => {
    const parser = new HelperPacketParser();
    const header = Buffer.alloc(5);
    header.writeUInt32BE(9 * 1024 * 1024, 0);
    expect(parser.push(header)).toBeNull();
  });
});
