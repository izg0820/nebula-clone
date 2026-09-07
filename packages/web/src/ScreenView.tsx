import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeViewerFrame, FRAME_FORMAT_H264, FRAME_FORMAT_JPEG } from '@nebula/shared';
import { ApiClient, ApiError } from './api';
import { interpretGesture, toDevicePoint, ScreenSize } from './coordinates';

interface ScreenViewProps {
  readonly api: ApiClient;
  readonly serverUrl: string;
  readonly token: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly occupantId: string;
  readonly onError: (message: string) => void;
  /** 점유가 서버에서 무효(403 등)로 판명됐을 때 — 세션 정리용 */
  readonly onOccupationLost: () => void;
  readonly onRelease: () => void;
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

/** 디코드 큐가 이 이상 밀리면 과부하 — 키프레임부터 재동기화. 5개 ≈ 지연 상한 ~170ms */
const MAX_DECODE_QUEUE = 5;

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
  deviceName,
  occupantId,
  onError,
  onOccupationLost,
  onRelease,
}: ScreenViewProps) {
  const [jpegUrl, setJpegUrl] = useState<string | null>(null);
  const [isVideoMode, setIsVideoMode] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  /** 탭 좌표 환산용 pt 크기 — JPEG 프레임 헤더 또는 점유 직후 스크린샷 1회로 확보 */
  const [screenPt, setScreenPt] = useState<ScreenSize | null>(null);
  const [text, setText] = useState('');
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 실시간 fps 표시 — 1초 창 프레임 카운트
  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

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
      frameCountRef.current += 1;

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

  /** 드래그 시작점 (클릭=탭 / 드래그=스와이프 판별용) — pointerId로 캡처한 포인터만 추적 */
  const pointerStartRef = useRef<{ x: number; y: number; time: number; pointerId: number } | null>(
    null,
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // 주 포인터의 좌클릭만 — 우클릭·휠클릭이 기기 탭으로 나가는 것 방지
    if (!event.isPrimary || event.button !== 0) return;
    // 캡처 — 화면 밖에서 놓아도 pointerup이 이 요소로 옴 (긴 스와이프 유실 방지)
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      pointerId: event.pointerId,
    };
  }, []);

  const handlePointerCancel = useCallback(() => {
    pointerStartRef.current = null;
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const start = pointerStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      pointerStartRef.current = null;
      if (!screenPt) {
        onError('화면 크기 정보 대기 중 — 잠시 후 다시 시도');
        return;
      }

      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      const from = toDevicePoint(
        start.x - rect.left,
        start.y - rect.top,
        element.clientWidth,
        element.clientHeight,
        screenPt,
      );
      const to = toDevicePoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        element.clientWidth,
        element.clientHeight,
        screenPt,
      );

      const gesture = interpretGesture(from, to, Date.now() - start.time, screenPt);
      if (gesture.kind === 'tap') {
        api.tap(deviceId, occupantId, gesture.x, gesture.y).catch((error: unknown) => {
          handleActionError('탭 실패', error);
        });
        return;
      }
      api
        .swipe(
          deviceId,
          occupantId,
          gesture.fromX,
          gesture.fromY,
          gesture.toX,
          gesture.toY,
          gesture.durationMs,
        )
        .catch((error: unknown) => handleActionError('스와이프 실패', error));
    },
    [api, deviceId, occupantId, screenPt, onError, handleActionError],
  );

  const handleHome = useCallback(() => {
    api.pressButton(deviceId, occupantId, 'home').catch((error: unknown) => {
      handleActionError('홈 실패', error);
    });
  }, [api, deviceId, occupantId, handleActionError]);

  /** iOS '뒤로' = 왼쪽 엣지 스와이프 */
  const handleBack = useCallback(() => {
    if (!screenPt) return;
    const midY = Math.round(screenPt.heightPt / 2);
    api
      .swipe(deviceId, occupantId, 1, midY, Math.round(screenPt.widthPt * 0.6), midY, 250)
      .catch((error: unknown) => handleActionError('뒤로가기 실패', error));
  }, [api, deviceId, occupantId, screenPt, handleActionError]);

  const handleType = useCallback(() => {
    if (text.length === 0) return;
    api
      .typeText(deviceId, occupantId, text)
      .then(() => setText(''))
      .catch((error: unknown) => handleActionError('입력 실패', error));
  }, [api, deviceId, occupantId, text, handleActionError]);

  /** 비디오 모드일 때만 캔버스 표시 (숨겨도 ref는 유지) */
  function canvasDisplay(): 'block' | 'none' {
    if (isVideoMode && hasFrame) return 'block';
    return 'none';
  }

  return (
    <div className="screen-panel">
      <div className="screen-toolbar">
        <span className="dot green" />
        <span className="device-name">{deviceName}</span>
        {hasFrame && <span className="fps-badge">{fps} fps</span>}
        <span className="spacer" />
        <button className="btn" onClick={handleBack} title="왼쪽 엣지 스와이프">
          ← 뒤로
        </button>
        <button className="btn" onClick={handleHome}>
          ⌂ 홈
        </button>
        <button className="btn danger" onClick={onRelease}>
          해제
        </button>
      </div>

      {!hasFrame && (
        <div className="placeholder">
          <div className="big">스트림 연결 중…</div>
          <div>러너 준비·첫 프레임 대기</div>
        </div>
      )}
      <div className="phone-frame" style={{ display: hasFrame ? 'block' : 'none' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          style={{ display: canvasDisplay() }}
        />
        {!isVideoMode && jpegUrl && (
          <img
            ref={imgRef}
            src={jpegUrl}
            alt="기기 화면"
            draggable={false}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />
        )}
      </div>

      <div className="type-row">
        <input
          className="input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="텍스트 입력 (기기에서 키보드 포커스 필요)"
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleType();
          }}
        />
        <button className="btn primary" onClick={handleType}>
          입력
        </button>
      </div>
    </div>
  );
}
