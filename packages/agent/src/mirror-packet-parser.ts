/**
 * Android 미러링 전송 프로토콜 파서 — android-controller/mirror MirrorProtocol.kt와 쌍 (big-endian)
 *
 * 프리앰블 16B: [u32 magic 'NBLA'][u16 ver=1][u8 codec=1][u8 rsv][u16 w][u16 h][u32 rsv]
 * 패킷 14B 헤더: [u8 flags(bit0 key)][u8 rsv][u16 w][u16 h][u32 ptsMs][u32 len] + Annex-B payload
 *
 * 해상도가 매 패킷에 실려 있어 접힘/회전에 파서 상태가 없음. SPS/PPS는 키프레임 payload에 인밴드
 */

const MAGIC = 0x4e424c41; // 'NBLA'
const VERSION = 1;
const CODEC_H264 = 1;
const PREAMBLE_BYTES = 16;
const PACKET_HEADER_BYTES = 14;
const FLAG_KEY = 0x01;
/** 패킷 상한 — 손상 스트림으로 인한 메모리 폭주 방지 (iOS HelperPacketParser와 동일 정책) */
const MAX_PACKET_BYTES = 8 * 1024 * 1024;

export interface MirrorPacket {
  readonly isKey: boolean;
  readonly width: number;
  readonly height: number;
  readonly ptsMs: number;
  readonly payload: Buffer;
}

export interface MirrorPreamble {
  readonly width: number;
  readonly height: number;
}

/** 증분 파서 — 손상 감지 시 poison (재시작 전까지 수신 무시) */
export class MirrorPacketParser {
  private buffer: Buffer = Buffer.alloc(0);
  private isPoisoned = false;
  private parsedPreamble: MirrorPreamble | null = null;

  /** 프리앰블 수신 여부 — 기동 데드라인 판정용 */
  get preamble(): MirrorPreamble | null {
    return this.parsedPreamble;
  }

  /** 수신 청크 추가 후 완성된 패킷들 반환. 손상(매직·버전·코덱·길이) 감지 시 null */
  push(chunk: Buffer): MirrorPacket[] | null {
    if (this.isPoisoned) return null;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.parsedPreamble) {
      const preamble = this.consumePreamble();
      if (preamble === 'need-more') return [];
      if (preamble === null) return this.poison();
      this.parsedPreamble = preamble;
    }
    return this.consumePackets();
  }

  private consumePreamble(): MirrorPreamble | 'need-more' | null {
    if (this.buffer.length < PREAMBLE_BYTES) return 'need-more';
    if (this.buffer.readUInt32BE(0) !== MAGIC) return null;
    if (this.buffer.readUInt16BE(4) !== VERSION) return null;
    if (this.buffer[6] !== CODEC_H264) return null;

    const width = this.buffer.readUInt16BE(8);
    const height = this.buffer.readUInt16BE(10);
    if (width === 0 || height === 0) return null;
    this.buffer = this.buffer.subarray(PREAMBLE_BYTES);
    return { width, height };
  }

  private consumePackets(): MirrorPacket[] | null {
    const packets: MirrorPacket[] = [];
    while (this.buffer.length >= PACKET_HEADER_BYTES) {
      const width = this.buffer.readUInt16BE(2);
      const height = this.buffer.readUInt16BE(4);
      const length = this.buffer.readUInt32BE(10);
      if (width === 0 || height === 0 || length === 0 || length > MAX_PACKET_BYTES) {
        return this.poison();
      }
      if (this.buffer.length < PACKET_HEADER_BYTES + length) break;

      packets.push({
        isKey: (this.buffer[0] & FLAG_KEY) !== 0,
        width,
        height,
        ptsMs: this.buffer.readUInt32BE(6),
        payload: this.buffer.subarray(PACKET_HEADER_BYTES, PACKET_HEADER_BYTES + length),
      });
      this.buffer = this.buffer.subarray(PACKET_HEADER_BYTES + length);
    }
    return packets;
  }

  private poison(): null {
    this.isPoisoned = true;
    this.buffer = Buffer.alloc(0);
    return null;
  }
}
