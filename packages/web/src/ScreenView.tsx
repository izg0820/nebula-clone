import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeViewerFrame } from '@nebula/shared';
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

/** 기기 화면 뷰 — 서버가 릴레이하는 프레임 스트림(WS 푸시)을 표시, 클릭=탭 */
export function ScreenView({
  api,
  serverUrl,
  token,
  deviceId,
  occupantId,
  onError,
  onOccupationLost,
}: ScreenViewProps) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [screenSize, setScreenSize] = useState<ScreenSize | null>(null);
  const [text, setText] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // effect 지역 상태만 사용 — 인스턴스 간 공유 ref는 StrictMode에서 루프 증식 유발
    let isActive = true;
    let currentObjectUrl: string | null = null;
    const socket = new WebSocket(toStreamUrl(serverUrl, deviceId, token));
    socket.binaryType = 'arraybuffer';

    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!isActive) return;
      const frame = decodeViewerFrame(new Uint8Array(event.data));
      if (!frame) return;

      const nextUrl = URL.createObjectURL(new Blob([frame.jpeg.slice()], { type: 'image/jpeg' }));
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = nextUrl;
      setFrameUrl(nextUrl);
      setScreenSize({ widthPt: frame.widthPt, heightPt: frame.heightPt });
    };
    socket.onclose = (event) => {
      if (!isActive) return;
      if (event.code === 4401) onError('스트림 인증 실패 — 토큰 확인');
    };

    return () => {
      isActive = false;
      socket.close();
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    };
  }, [serverUrl, token, deviceId, onError]);

  /** 403 = 점유가 서버에서 사라짐 — 폴링·재시도 대신 세션 정리 */
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

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img || !screenSize) return;
      const point = toDevicePoint(
        event.clientX - img.getBoundingClientRect().left,
        event.clientY - img.getBoundingClientRect().top,
        img.clientWidth,
        img.clientHeight,
        screenSize,
      );
      api.tap(deviceId, occupantId, point.x, point.y).catch((error: unknown) => {
        handleActionError('탭 실패', error);
      });
    },
    [api, deviceId, occupantId, screenSize, handleActionError],
  );

  const handleType = useCallback(() => {
    if (text.length === 0) return;
    api
      .typeText(deviceId, occupantId, text)
      .then(() => setText(''))
      .catch((error: unknown) => handleActionError('입력 실패', error));
  }, [api, deviceId, occupantId, text, handleActionError]);

  if (!frameUrl) return <p>스트림 연결 중… (러너 준비·첫 프레임 대기)</p>;

  return (
    <div>
      <img
        ref={imgRef}
        src={frameUrl}
        alt="기기 화면"
        onClick={handleClick}
        style={{
          maxHeight: '80vh',
          maxWidth: '100%',
          cursor: 'crosshair',
          border: '1px solid #ccc',
          boxSizing: 'content-box',
        }}
      />
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
