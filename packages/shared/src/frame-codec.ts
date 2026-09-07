/**
 * 미러링 프레임 바이너리 코덱 — Node(Agent·서버)와 브라우저(웹) 공용
 * Buffer 대신 Uint8Array/DataView만 사용 (브라우저 호환)
 *
 * Agent → 서버: [u8 deviceId 길이][deviceId utf8][u16BE widthPt][u16BE heightPt][JPEG]
 * 서버 → 시청자: [u16BE widthPt][u16BE heightPt][JPEG]  (deviceId는 구독으로 이미 결정됨)
 */

export interface AgentFrame {
  readonly deviceId: string;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly jpeg: Uint8Array;
}

export interface ViewerFrame {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly jpeg: Uint8Array;
}

const MAX_DEVICE_ID_BYTES = 255;
const MAX_PT = 65_535;

export function encodeAgentFrame(frame: AgentFrame): Uint8Array {
  const idBytes = new TextEncoder().encode(frame.deviceId);
  if (idBytes.length === 0 || idBytes.length > MAX_DEVICE_ID_BYTES) {
    throw new Error(`deviceId 길이 초과: ${idBytes.length}`);
  }
  if (frame.widthPt > MAX_PT || frame.heightPt > MAX_PT) {
    throw new Error('pt 크기 범위 초과');
  }

  const out = new Uint8Array(1 + idBytes.length + 4 + frame.jpeg.length);
  const view = new DataView(out.buffer);
  out[0] = idBytes.length;
  out.set(idBytes, 1);
  view.setUint16(1 + idBytes.length, frame.widthPt);
  view.setUint16(3 + idBytes.length, frame.heightPt);
  out.set(frame.jpeg, 5 + idBytes.length);
  return out;
}

/** 형식 불일치 시 null (신뢰 경계 파서) */
export function decodeAgentFrame(data: Uint8Array): AgentFrame | null {
  if (data.length < 6) return null;
  const idLength = data[0];
  if (idLength === 0 || data.length < 1 + idLength + 4 + 1) return null;

  const deviceId = new TextDecoder().decode(data.subarray(1, 1 + idLength));
  const view = new DataView(data.buffer, data.byteOffset);
  return {
    deviceId,
    widthPt: view.getUint16(1 + idLength),
    heightPt: view.getUint16(3 + idLength),
    jpeg: data.subarray(5 + idLength),
  };
}

export function encodeViewerFrame(frame: ViewerFrame): Uint8Array {
  const out = new Uint8Array(4 + frame.jpeg.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, frame.widthPt);
  view.setUint16(2, frame.heightPt);
  out.set(frame.jpeg, 4);
  return out;
}

/** 형식 불일치 시 null */
export function decodeViewerFrame(data: Uint8Array): ViewerFrame | null {
  if (data.length < 5) return null;
  const view = new DataView(data.buffer, data.byteOffset);
  return {
    widthPt: view.getUint16(0),
    heightPt: view.getUint16(2),
    jpeg: data.subarray(4),
  };
}
