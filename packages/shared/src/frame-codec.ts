/**
 * 미러링 프레임 바이너리 코덱 — Node(Agent·서버)와 브라우저(웹) 공용
 * Buffer 대신 Uint8Array/DataView만 사용 (브라우저 호환)
 *
 * Agent → 서버: [u8 idLen][deviceId utf8][u8 format][u8 isKey][u16BE width][u16BE height][u32BE stampMs][payload]
 * 서버 → 시청자: [u8 format][u8 isKey][u16BE width][u16BE height][u32BE stampMs][payload]
 *
 * stampMs: Agent가 프레임을 수신한 시각(Date.now() 하위 32비트) — 구간별 지연 측정용
 * (Agent와 시청 브라우저가 같은 맥이면 시계가 동일해 절대 지연으로 해석 가능)
 *
 * format=jpeg: width/height는 pt (스크린샷 방식), isKey는 항상 1 (모든 프레임 독립)
 * format=h264: width/height는 px (인코더 해상도), payload는 Annex-B access unit
 */

export const FRAME_FORMAT_JPEG = 1;
export const FRAME_FORMAT_H264 = 2;
export type FrameFormat = typeof FRAME_FORMAT_JPEG | typeof FRAME_FORMAT_H264;

export interface AgentFrame {
  readonly deviceId: string;
  readonly format: FrameFormat;
  readonly isKey: boolean;
  readonly width: number;
  readonly height: number;
  /** Agent 수신 시각 (Date.now() 하위 32비트, ms) — 지연 측정용 */
  readonly stampMs: number;
  readonly payload: Uint8Array;
}

export interface ViewerFrame {
  readonly format: FrameFormat;
  readonly isKey: boolean;
  readonly width: number;
  readonly height: number;
  /** Agent 수신 시각 (Date.now() 하위 32비트, ms) — 지연 측정용 */
  readonly stampMs: number;
  readonly payload: Uint8Array;
}

const MAX_DEVICE_ID_BYTES = 255;
const MAX_DIMENSION = 65_535;

function isFrameFormat(value: number): value is FrameFormat {
  return value === FRAME_FORMAT_JPEG || value === FRAME_FORMAT_H264;
}

export function encodeAgentFrame(frame: AgentFrame): Uint8Array {
  const idBytes = new TextEncoder().encode(frame.deviceId);
  if (idBytes.length === 0 || idBytes.length > MAX_DEVICE_ID_BYTES) {
    throw new Error(`deviceId 길이 초과: ${idBytes.length}`);
  }
  if (frame.width > MAX_DIMENSION || frame.height > MAX_DIMENSION) {
    throw new Error('프레임 크기 범위 초과');
  }

  const out = new Uint8Array(1 + idBytes.length + 10 + frame.payload.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset] = idBytes.length;
  offset += 1;
  out.set(idBytes, offset);
  offset += idBytes.length;
  out[offset] = frame.format;
  out[offset + 1] = frame.isKey ? 1 : 0;
  view.setUint16(offset + 2, frame.width);
  view.setUint16(offset + 4, frame.height);
  view.setUint32(offset + 6, frame.stampMs >>> 0);
  out.set(frame.payload, offset + 10);
  return out;
}

/** 형식 불일치 시 null (신뢰 경계 파서) */
export function decodeAgentFrame(data: Uint8Array): AgentFrame | null {
  if (data.length < 12) return null;
  const idLength = data[0];
  if (idLength === 0 || data.length < 1 + idLength + 10 + 1) return null;

  const deviceId = new TextDecoder().decode(data.subarray(1, 1 + idLength));
  const view = new DataView(data.buffer, data.byteOffset);
  const format = data[1 + idLength];
  if (!isFrameFormat(format)) return null;

  return {
    deviceId,
    format,
    isKey: data[2 + idLength] === 1,
    width: view.getUint16(3 + idLength),
    height: view.getUint16(5 + idLength),
    stampMs: view.getUint32(7 + idLength),
    payload: data.subarray(11 + idLength),
  };
}

export function encodeViewerFrame(frame: ViewerFrame): Uint8Array {
  const out = new Uint8Array(10 + frame.payload.length);
  const view = new DataView(out.buffer);
  out[0] = frame.format;
  out[1] = frame.isKey ? 1 : 0;
  view.setUint16(2, frame.width);
  view.setUint16(4, frame.height);
  view.setUint32(6, frame.stampMs >>> 0);
  out.set(frame.payload, 10);
  return out;
}

/** 형식 불일치 시 null */
export function decodeViewerFrame(data: Uint8Array): ViewerFrame | null {
  if (data.length < 11) return null;
  const format = data[0];
  if (!isFrameFormat(format)) return null;

  const view = new DataView(data.buffer, data.byteOffset);
  return {
    format,
    isKey: data[1] === 1,
    width: view.getUint16(2),
    height: view.getUint16(4),
    stampMs: view.getUint32(6),
    payload: data.subarray(10),
  };
}
