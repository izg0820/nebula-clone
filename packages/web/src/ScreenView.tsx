import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeViewerFrame } from '@nebula/shared';
import { ApiError, NebulaClient, toErrorMessage } from '@nebula/client';
import { interpretGesture, toDevicePoint, ScreenSize } from './coordinates';

interface ScreenViewProps {
  readonly api: NebulaClient;
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

/** http(s) → ws(s) 스킴 변환 — 파싱 실패는 null (설정 입력 중 잘못된 URL로 앱이 죽지 않게) */
export function toStreamUrl(
  serverUrl: string,
  deviceId: string,
  token: string,
  occupantId: string,
): string | null {
  try {
    const url = new URL(serverUrl);
    url.protocol = toWsProtocol(url.protocol);
    url.pathname = '/stream';
    url.searchParams.set('deviceId', deviceId);
    url.searchParams.set('token', token);
    // 화면 관람도 점유자 전용 (서버가 4403으로 거부)
    url.searchParams.set('occupantId', occupantId);
    return url.toString();
  } catch {
    return null;
  }
}

function toWsProtocol(httpProtocol: string): string {
  if (httpProtocol === 'https:') return 'wss:';
  return 'ws:';
}

/** 디코드 큐가 이 이상 밀리면 과부하 — 키프레임부터 재동기화. 5개 ≈ 지연 상한 ~170ms */
const MAX_DECODE_QUEUE = 5;

/** 재시도해도 소용없는 스트림 종료 코드 → 사용자 안내 (그 외 코드는 백오프 재연결) */
const STREAM_TERMINAL_CLOSE_MESSAGES: Record<number, string> = {
  4400: '스트림 요청 형식 오류 (deviceId/occupantId 누락)',
  4401: '스트림 인증 실패 — 토큰 확인',
  4403: '점유자가 아니어서 화면을 볼 수 없습니다 — 기기를 다시 점유하세요',
  4408: '점유가 만료됐습니다 — 다시 점유하세요',
  4429: '연결 시도 과다 — 잠시 후 다시 시도하세요',
};

/** 서버가 점유를 인정하지 않는 종료 — 세션(occupantId)을 들고 있어도 무의미 */
const STREAM_OCCUPATION_LOST_CODES = new Set([4403, 4408]);

export interface StreamCloseOutcome {
  readonly message: string;
  readonly isOccupationLost: boolean;
}

/** 종료 코드 해석 — null이면 터미널 아님(백오프 재연결 대상) */
export function streamCloseOutcome(code: number): StreamCloseOutcome | null {
  const message = STREAM_TERMINAL_CLOSE_MESSAGES[code];
  if (!message) return null;
  return { message, isOccupationLost: STREAM_OCCUPATION_LOST_CODES.has(code) };
}
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 15_000;

/** 디코드 연속 실패가 이 횟수에 달하면 사용자에게 표면화 (일시 오류는 키프레임 재동기화로 조용히 복구) */
const DECODE_FAILURE_REPORT_THRESHOLD = 3;

function toChunkType(isKey: boolean): EncodedVideoChunkType {
  if (isKey) return 'key';
  return 'delta';
}

function frameDisplay(hasFrame: boolean): 'block' | 'none' {
  if (hasFrame) return 'block';
  return 'none';
}

/** H.264 Annex-B 스트림용 WebCodecs 디코더 — 키프레임 대기 후 기동, 오류 시 다음 키프레임까지 리셋 */
class H264Player {
  private decoder: VideoDecoder | null = null;
  private isWaitingKeyframe = true;
  private timestamp = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** 프레임이 실제로 디코드·표시됨 — fps 집계는 수신이 아니라 이 기준 */
    private readonly onDecoded: () => void,
    /** 반복 실패 — 검은 화면인데 fps만 도는 무증상 상태를 사용자에게 알림 */
    private readonly onFailure: (message: string) => void,
  ) {}

  push(payload: Uint8Array, isKey: boolean, width: number, height: number): void {
    try {
      this.decodeChunk(payload, isKey, width, height);
    } catch (error) {
      // configure/decode 동기 예외 — WS 핸들러 밖으로 새면 조용히 사라짐
      this.recordFailure(`디코더 오류: ${toErrorMessage(error)}`);
      this.isWaitingKeyframe = true;
      this.close();
    }
  }

  private decodeChunk(payload: Uint8Array, isKey: boolean, width: number, height: number): void {
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
        type: toChunkType(isKey),
        timestamp: this.timestamp,
        data: payload as BufferSource,
      }),
    );
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  private recordFailure(message: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === DECODE_FAILURE_REPORT_THRESHOLD) {
      this.onFailure(`H.264 디코딩 반복 실패 — ${message}`);
    }
  }

  private createDecoder(width: number, height: number): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // 캔버스 크기 대입은 값이 같아도 전체 클리어를 유발 — 변경 시에만 (매 프레임 리셋 = 깜빡임)
        if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
        if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
        this.canvas.getContext('2d')?.drawImage(frame, 0, 0);
        frame.close();
        this.consecutiveFailures = 0;
        this.onDecoded();
      },
      error: (error: DOMException) => {
        // 디코드 오류 — 다음 키프레임부터 재기동, 반복되면 표면화
        this.recordFailure(error.message);
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

/** 기기 화면 뷰 — 서버 릴레이 스트림(H.264 WebCodecs) 표시, 클릭=탭 */
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
  const [hasFrame, setHasFrame] = useState(false);
  /** 탭 좌표 환산용 pt 크기 — H.264 프레임은 px 단위라 점유 직후 스크린샷 1회로 확보 */
  const [screenPt, setScreenPt] = useState<ScreenSize | null>(null);
  const [text, setText] = useState('');
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      onError(`${prefix}: ${toErrorMessage(error)}`);
    },
    [onError, onOccupationLost],
  );

  // pt 크기 확보 — H.264 프레임은 px 단위라 탭 좌표 환산에 pt가 별도로 필요
  useEffect(() => {
    let isActive = true;
    api
      .screenshot({ deviceId, occupantId })
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
    if (typeof VideoDecoder === 'undefined') {
      onError('이 브라우저는 WebCodecs를 지원하지 않아 미러링을 표시할 수 없습니다');
      return;
    }
    const streamUrl = toStreamUrl(serverUrl, deviceId, token, occupantId);
    if (!streamUrl) {
      onError('서버 주소 형식 오류 — 스트림 연결 불가');
      return;
    }

    let isActive = true;
    let player: H264Player | null = null;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const createPlayer = (canvas: HTMLCanvasElement): H264Player =>
      new H264Player(
        canvas,
        () => {
          // fps·표시 여부는 실제 디코드 기준 — 수신 기준이면 "fps는 도는데 검은 화면"을 못 알아챔
          frameCountRef.current += 1;
          setHasFrame(true);
        },
        (message) => {
          if (isActive) onError(message);
        },
      );

    const connect = (): void => {
      if (!isActive) return;
      socket = new WebSocket(streamUrl);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        reconnectAttempt = 0;
      };
      socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!isActive) return;
        const frame = decodeViewerFrame(new Uint8Array(event.data));
        if (!frame) return;

        if (!player && canvasRef.current) player = createPlayer(canvasRef.current);
        player?.push(frame.payload, frame.isKey, frame.width, frame.height);
      };
      socket.onclose = (event) => {
        if (!isActive) return;
        // 굳은 마지막 프레임을 실시간 화면으로 오인하지 않게 즉시 연결 중 표시로 전환
        setHasFrame(false);
        const outcome = streamCloseOutcome(event.code);
        if (outcome) {
          onError(outcome.message);
          // 만료(4408)·비점유자(4403)는 세션이 무효 — 들고 있어봐야 모든 요청이 403
          if (outcome.isOccupationLost) onOccupationLost();
          return;
        }
        // 서버 재기동·일시 단선은 백오프 재연결 (Agent 터널과 대칭)
        const delay = Math.min(
          STREAM_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
          STREAM_RECONNECT_MAX_MS,
        );
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      isActive = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.close();
      player?.close();
    };
    // onOccupationLost는 App이 useCallback으로 안정 identity 보장 — 인라인이면 재연결 폭주
  }, [serverUrl, token, deviceId, occupantId, onError, onOccupationLost]);

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
        api.tap({ deviceId, occupantId }, { x: gesture.x, y: gesture.y }).catch(
          (error: unknown) => {
            handleActionError('탭 실패', error);
          },
        );
        return;
      }
      api
        .swipe(
          { deviceId, occupantId },
          {
            fromX: gesture.fromX,
            fromY: gesture.fromY,
            toX: gesture.toX,
            toY: gesture.toY,
            durationMs: gesture.durationMs,
          },
        )
        .catch((error: unknown) => handleActionError('스와이프 실패', error));
    },
    [api, deviceId, occupantId, screenPt, onError, handleActionError],
  );

  const handleHome = useCallback(() => {
    api.pressButton({ deviceId, occupantId }, 'home').catch((error: unknown) => {
      handleActionError('홈 실패', error);
    });
  }, [api, deviceId, occupantId, handleActionError]);

  /** iOS '뒤로' = 왼쪽 엣지 스와이프 */
  const handleBack = useCallback(() => {
    if (!screenPt) return;
    const midY = Math.round(screenPt.heightPt / 2);
    api
      .swipe(
        { deviceId, occupantId },
        { fromX: 1, fromY: midY, toX: Math.round(screenPt.widthPt * 0.6), toY: midY, durationMs: 250 },
      )
      .catch((error: unknown) => handleActionError('뒤로가기 실패', error));
  }, [api, deviceId, occupantId, screenPt, handleActionError]);

  const handleType = useCallback(() => {
    if (text.length === 0) return;
    api
      .typeText({ deviceId, occupantId }, text)
      .then(() => setText(''))
      .catch((error: unknown) => handleActionError('입력 실패', error));
  }, [api, deviceId, occupantId, text, handleActionError]);

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
      <div className="phone-frame" style={{ display: frameDisplay(hasFrame) }}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
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
