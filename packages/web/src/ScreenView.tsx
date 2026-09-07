import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeViewerFrame, FRAME_FORMAT_H264, FRAME_FORMAT_JPEG } from '@nebula/shared';
import { ApiClient, ApiError } from './api';
import { toDevicePoint, ScreenSize } from './coordinates';

interface ScreenViewProps {
  readonly api: ApiClient;
  readonly serverUrl: string;
  readonly token: string;
  readonly deviceId: string;
  readonly occupantId: string;
  readonly onError: (message: string) => void;
  /** 점유가 서버에서 무효(403 등)로 판명됐을 때 — 세션 정리용 */
  readonly onOccupationLost: () => void;
}

/** http(s) → ws(s) 스킴 변환 */
function toStreamUrl(serverUrl: string, deviceId: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/stream';
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('token', token);
  return url.toString();
}

/** 디코드 큐가 이 이상 밀리면 과부하 — 키프레임부터 재동기화 (지연 누적 방지) */
const MAX_DECODE_QUEUE = 15;

/** H.264 Annex-B 스트림용 WebCodecs 디코더 — 키프레임 대기 후 기동, 오류 시 다음 키프레임까지 리셋 */
class H264Player {
  private decoder: VideoDecoder | null = null;
  private isWaitingKeyframe = true;
  private timestamp = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  push(payload: Uint8Array, isKey: boolean, width: number, height: number): void {
    if (this.isWaitingKeyframe && !isKey) return;

    // 디코더가 못 따라오면 큐를 버리고 다음 키프레임부터 — 지연이 계속 커지는 것 방지
    if (this.decoder && this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.close();
      this.isWaitingKeyframe = true;
      if (!isKey) return;
    }

    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = this.createDecoder(width, height);
    }
    this.isWaitingKeyframe = false;
    this.timestamp += 33_000; // ~30fps 가정의 단조 증가 타임스탬프 (µs)

    this.decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: this.timestamp,
        data: payload as BufferSource,
      }),
    );
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  private createDecoder(width: number, height: number): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // 캔버스 크기 대입은 값이 같아도 전체 클리어를 유발 — 변경 시에만 (매 프레임 리셋 = 깜빡임)
        if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
        if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
        this.canvas.getContext('2d')?.drawImage(frame, 0, 0);
        frame.close();
      },
      error: () => {
        // 디코드 오류 — 다음 키프레임부터 재기동
        this.isWaitingKeyframe = true;
        this.close();
      },
    });
    // description 미지정 = Annex-B 모드 (SPS/PPS 인밴드)
    decoder.configure({
      codec: 'avc1.4d0032',
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    });
    return decoder;
  }
}

/** 기기 화면 뷰 — 서버 릴레이 스트림(H.264 WebCodecs 또는 JPEG 폴백) 표시, 클릭=탭 */
export function ScreenView({
  api,
  serverUrl,
  token,
  deviceId,
  occupantId,
  onError,
  onOccupationLost,
}: ScreenViewProps) {
  const [jpegUrl, setJpegUrl] = useState<string | null>(null);
  const [isVideoMode, setIsVideoMode] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  /** 탭 좌표 환산용 pt 크기 — JPEG 프레임 헤더 또는 점유 직후 스크린샷 1회로 확보 */
  const [screenPt, setScreenPt] = useState<ScreenSize | null>(null);
  const [text, setText] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  /** 403 = 점유가 서버에서 사라짐 — 재시도 대신 세션 정리 */
  const handleActionError = useCallback(
    (prefix: string, error: unknown) => {
      if (error instanceof ApiError && error.status === 403) {
        onOccupationLost();
        onError('점유가 만료되어 해제됐습니다 — 다시 점유해주세요');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      onError(`${prefix}: ${message}`);
    },
    [onError, onOccupationLost],
  );

  // pt 크기 확보 — H.264 프레임은 px 단위라 탭 좌표 환산에 pt가 별도로 필요
  useEffect(() => {
    let isActive = true;
    api
      .screenshot(deviceId, occupantId)
      .then((result) => {
        if (isActive) setScreenPt({ widthPt: result.widthPt, heightPt: result.heightPt });
      })
      .catch((error: unknown) => {
        if (isActive) handleActionError('화면 크기 확인 실패', error);
      });
    return () => {
      isActive = false;
    };
  }, [api, deviceId, occupantId, handleActionError]);

  // 스트림 수신
  useEffect(() => {
    let isActive = true;
    let currentObjectUrl: string | null = null;
    let player: H264Player | null = null;
    const socket = new WebSocket(toStreamUrl(serverUrl, deviceId, token));
    socket.binaryType = 'arraybuffer';

    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!isActive) return;
      const frame = decodeViewerFrame(new Uint8Array(event.data));
      if (!frame) return;

      if (frame.format === FRAME_FORMAT_H264) {
        setIsVideoMode(true);
        setHasFrame(true);
        if (!player && canvasRef.current) player = new H264Player(canvasRef.current);
        player?.push(frame.payload, frame.isKey, frame.width, frame.height);
        return;
      }
      if (frame.format === FRAME_FORMAT_JPEG) {
        setIsVideoMode(false);
        setHasFrame(true);
        // JPEG 헤더의 크기는 pt — 환산 정보로도 사용
        setScreenPt({ widthPt: frame.width, heightPt: frame.height });
        const nextUrl = URL.createObjectURL(
          new Blob([frame.payload.slice()], { type: 'image/jpeg' }),
        );
        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = nextUrl;
        setJpegUrl(nextUrl);
      }
    };
    socket.onclose = (event) => {
      if (!isActive) return;
      if (event.code === 4401) onError('스트림 인증 실패 — 토큰 확인');
    };

    return () => {
      isActive = false;
      socket.close();
      player?.close();
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    };
  }, [serverUrl, token, deviceId, onError]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const element = event.currentTarget;
      if (!screenPt) {
        onError('화면 크기 정보 대기 중 — 잠시 후 다시 클릭');
        return;
      }
      const rect = element.getBoundingClientRect();
      const point = toDevicePoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        element.clientWidth,
        element.clientHeight,
        screenPt,
      );
      api.tap(deviceId, occupantId, point.x, point.y).catch((error: unknown) => {
        handleActionError('탭 실패', error);
      });
    },
    [api, deviceId, occupantId, screenPt, onError, handleActionError],
  );

  const handleType = useCallback(() => {
    if (text.length === 0) return;
    api
      .typeText(deviceId, occupantId, text)
      .then(() => setText(''))
      .catch((error: unknown) => handleActionError('입력 실패', error));
  }, [api, deviceId, occupantId, text, handleActionError]);

  const viewStyle: React.CSSProperties = {
    maxHeight: '80vh',
    maxWidth: '100%',
    cursor: 'crosshair',
    border: '1px solid #ccc',
    boxSizing: 'content-box',
  };

  return (
    <div>
      {!hasFrame && <p>스트림 연결 중… (러너 준비·첫 프레임 대기)</p>}
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ ...viewStyle, display: isVideoMode && hasFrame ? 'block' : 'none' }}
      />
      {!isVideoMode && jpegUrl && (
        <img ref={imgRef} src={jpegUrl} alt="기기 화면" onClick={handleClick} style={viewStyle} />
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="텍스트 입력 (기기에서 키보드 포커스 필요)"
          style={{ flex: 1 }}
        />
        <button onClick={handleType}>입력</button>
      </div>
    </div>
  );
}
