import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, NebulaClient, PublicDevice, toErrorMessage } from '@nebula/client';
import { DeviceCard } from './DeviceCard';
import { ScreenView } from './ScreenView';
import { SettingsPanel } from './SettingsPanel';
import { parseIntervalEnv } from './env';
import { useOccupationKeepalive } from './useOccupationKeepalive';

const DEVICE_POLL_INTERVAL_MS = parseIntervalEnv(
  import.meta.env.VITE_DEVICE_POLL_INTERVAL_MS,
  5_000,
);
// dev.sh가 실제 서버 포트를 VITE_SERVER_URL로 주입 (server/.env의 PORT와 일치) — 미주입 시 3000
const DEFAULT_SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';
const MIN_TOKEN_LENGTH = 24;

/** 점유 세션 (localStorage 보존 — 새로고침 시 유지) */
interface Occupation {
  readonly deviceId: string;
  readonly occupantId: string;
}

function loadStored(key: string): string {
  return localStorage.getItem(key) ?? '';
}

function loadStoredOccupation(): Occupation | null {
  // localStorage 손상 시 백지 화면 방지 — 파싱 실패는 세션 없음으로 처리
  try {
    const raw = localStorage.getItem('occupation');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Occupation>;
    if (typeof parsed.deviceId !== 'string' || typeof parsed.occupantId !== 'string') return null;
    return { deviceId: parsed.deviceId, occupantId: parsed.occupantId };
  } catch {
    localStorage.removeItem('occupation');
    return null;
  }
}

export function App() {
  // 적용된(연결된) 설정 — 입력 필드는 SettingsPanel의 draft, "연결" 클릭 시에만 여기로 커밋
  const [serverUrl, setServerUrl] = useState(loadStored('serverUrl') || DEFAULT_SERVER_URL);
  const [token, setToken] = useState(loadStored('token'));
  const [isConnected, setIsConnected] = useState(false);
  const [devices, setDevices] = useState<PublicDevice[]>([]);
  const [occupation, setOccupation] = useState<Occupation | null>(loadStoredOccupation);
  const [status, setStatus] = useState('');

  const api = useMemo(() => new NebulaClient({ baseUrl: serverUrl, token }), [serverUrl, token]);

  useEffect(() => {
    if (occupation) {
      localStorage.setItem('occupation', JSON.stringify(occupation));
      return;
    }
    localStorage.removeItem('occupation');
  }, [occupation]);

  const handleConnect = useCallback((nextServerUrl: string, nextToken: string) => {
    if (nextToken.length < MIN_TOKEN_LENGTH) {
      setStatus(`토큰은 ${MIN_TOKEN_LENGTH}자 이상이어야 합니다`);
      return;
    }
    localStorage.setItem('serverUrl', nextServerUrl);
    localStorage.setItem('token', nextToken);
    setServerUrl(nextServerUrl);
    setToken(nextToken);
    setIsConnected(true);
    setStatus('연결 중…');
  }, []);

  const handleDisconnect = useCallback(() => {
    setIsConnected(false);
    setDevices([]);
    setStatus('연결 해제됨');
  }, []);

  // 기기 목록 폴링 — "연결" 상태일 때만 (자동 연결 안 함 — 명시적 버튼 필요)
  useEffect(() => {
    if (!isConnected) return;
    let isActive = true;

    async function poll(): Promise<void> {
      try {
        const list = await api.listDevices();
        if (isActive) {
          setDevices(list);
          setStatus(`연결됨 · ${serverUrl}`);
        }
      } catch (error) {
        if (isActive) setStatus(`연결 실패: ${(error as Error).message} — 주소·토큰 확인 후 다시 연결`);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), DEVICE_POLL_INTERVAL_MS);
    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [api, isConnected, serverUrl]);

  const handleOccupy = useCallback(
    (deviceId: string) => {
      api
        .occupy({ deviceId })
        .then((result) => {
          setOccupation({ deviceId: result.device.id, occupantId: result.occupantId });
          setStatus('');
        })
        .catch((error: Error) => setStatus(`점유 실패: ${error.message}`));
    },
    [api],
  );

  // 안정 identity 필수 — 인라인 함수면 5초 폴링 리렌더마다 ScreenView의 effect가 재실행되어
  // 점유 기기에 스크린샷 명령이 주기적으로 재발행됨 (러너 메인 스레드 점유 → 헬스 오탐)
  const handleOccupationLost = useCallback(() => setOccupation(null), []);

  // 점유 sliding TTL 유지 — 30초마다 keepalive (연결 상태에서만; 활동 없으면 서버가 10분 후 회수)
  useOccupationKeepalive(api, isConnected ? occupation : null, handleOccupationLost, setStatus);

  const handleRelease = useCallback(() => {
    if (!occupation) return;
    api
      .release(occupation.deviceId, occupation.occupantId)
      .then(() => {
        setOccupation(null);
        setStatus('');
      })
      .catch((error: unknown) => {
        // 서버가 점유를 모르는 경우만 세션 폐기 — 403(불일치)·404(기기 없음)·
        // 409(만료 회수 후 미점유). 일시 오류에 occupantId를 버리면 해제 수단이 사라짐
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404 || error.status === 409)
        ) {
          setOccupation(null);
          setStatus('점유가 이미 무효라 세션을 정리했습니다');
          return;
        }
        setStatus(`해제 실패 — 세션 유지됨, 다시 시도하세요: ${toErrorMessage(error)}`);
      });
  }, [api, occupation]);

  const occupiedDevice = devices.find((device) => device.id === occupation?.deviceId);

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          ☄️ Nebula <span>Console</span>
        </div>
        <div className="tagline">iOS · Android 디바이스 팜 — 보면서 조작하기</div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="device-list">
            <div className="section-title">기기 ({devices.length})</div>
            {!isConnected && (
              <p className="placeholder">아래 &lsquo;연결&rsquo; 버튼을 누르면 기기 목록이 표시됩니다</p>
            )}
            {isConnected && devices.length === 0 && (
              <p className="placeholder">등록된 기기 없음 — Agent 연결 대기</p>
            )}
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                isMine={occupation?.deviceId === device.id}
                hasOtherOccupation={occupation !== null && occupation.deviceId !== device.id}
                onOccupy={handleOccupy}
                onRelease={handleRelease}
              />
            ))}
          </div>
          <SettingsPanel
            initialServerUrl={serverUrl}
            initialToken={token}
            isConnected={isConnected}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
        </aside>

        <main className="main">
          {isConnected && occupation && (
            <ScreenView
              key={occupation.deviceId}
              api={api}
              serverUrl={serverUrl}
              token={token}
              deviceId={occupation.deviceId}
              deviceName={occupiedDevice?.name ?? occupation.deviceId}
              platform={occupiedDevice?.platform ?? 'ios'}
              occupantId={occupation.occupantId}
              onError={setStatus}
              onOccupationLost={handleOccupationLost}
              onRelease={handleRelease}
            />
          )}
          {!isConnected && (
            <div className="placeholder">
              <div className="big">서버에 연결하세요</div>
              <div>왼쪽 &lsquo;연결 설정&rsquo;에서 주소·토큰 입력 후 &lsquo;연결&rsquo;을 누르세요</div>
            </div>
          )}
          {isConnected && !occupation && (
            <div className="placeholder">
              <div className="big">기기를 점유하면 화면이 여기 표시됩니다</div>
              <div>왼쪽 목록에서 초록 도트(controller ready) 기기를 점유하세요</div>
            </div>
          )}
        </main>
      </div>

      <div className="status-line">{status}</div>
    </div>
  );
}
