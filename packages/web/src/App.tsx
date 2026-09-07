import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, PublicDevice } from './api';
import { DeviceCard } from './DeviceCard';
import { ScreenView } from './ScreenView';
import { SettingsPanel } from './SettingsPanel';

const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SERVER_URL = 'http://localhost:3000';
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
  const [serverUrl, setServerUrl] = useState(loadStored('serverUrl') || DEFAULT_SERVER_URL);
  const [token, setToken] = useState(loadStored('token'));
  const [devices, setDevices] = useState<PublicDevice[]>([]);
  const [occupation, setOccupation] = useState<Occupation | null>(loadStoredOccupation);
  const [status, setStatus] = useState('');

  const api = useMemo(() => new ApiClient(serverUrl, token), [serverUrl, token]);

  useEffect(() => {
    localStorage.setItem('serverUrl', serverUrl);
    localStorage.setItem('token', token);
  }, [serverUrl, token]);

  useEffect(() => {
    if (occupation) {
      localStorage.setItem('occupation', JSON.stringify(occupation));
      return;
    }
    localStorage.removeItem('occupation');
  }, [occupation]);

  // 기기 목록 폴링 — 토큰이 유효 길이일 때만 (입력 중 타이핑마다 401 요청 방지)
  useEffect(() => {
    if (token.length < MIN_TOKEN_LENGTH) return;
    let isActive = true;

    async function poll(): Promise<void> {
      try {
        const list = await api.listDevices();
        if (isActive) {
          setDevices(list);
          setStatus('');
        }
      } catch (error) {
        if (isActive) setStatus(`기기 목록 실패: ${(error as Error).message}`);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), DEVICE_POLL_INTERVAL_MS);
    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [api, token]);

  const handleOccupy = useCallback(
    (deviceId: string) => {
      api
        .occupy(deviceId)
        .then((result) => {
          setOccupation({ deviceId: result.device.id, occupantId: result.occupantId });
          setStatus('');
        })
        .catch((error: Error) => setStatus(`점유 실패: ${error.message}`));
    },
    [api],
  );

  const handleRelease = useCallback(() => {
    if (!occupation) return;
    api
      .release(occupation.deviceId, occupation.occupantId)
      .catch((error: Error) => setStatus(`해제 실패: ${error.message}`))
      .finally(() => setOccupation(null));
  }, [api, occupation]);

  const occupiedDevice = devices.find((device) => device.id === occupation?.deviceId);
  const needsToken = token.length < MIN_TOKEN_LENGTH;

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          ☄️ Nebula <span>Console</span>
        </div>
        <div className="tagline">iOS 디바이스 팜 — 보면서 조작하기</div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="device-list">
            <div className="section-title">기기 ({devices.length})</div>
            {needsToken && <p className="placeholder">토큰을 입력하면 기기 목록이 표시됩니다</p>}
            {!needsToken && devices.length === 0 && (
              <p className="placeholder">등록된 기기 없음 — Agent 연결 대기</p>
            )}
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                isMine={occupation?.deviceId === device.id}
                onOccupy={handleOccupy}
                onRelease={handleRelease}
              />
            ))}
          </div>
          <SettingsPanel
            serverUrl={serverUrl}
            token={token}
            onServerUrlChange={setServerUrl}
            onTokenChange={setToken}
          />
        </aside>

        <main className="main">
          {occupation && (
            <ScreenView
              api={api}
              serverUrl={serverUrl}
              token={token}
              deviceId={occupation.deviceId}
              deviceName={occupiedDevice?.name ?? occupation.deviceId}
              occupantId={occupation.occupantId}
              onError={setStatus}
              onOccupationLost={() => setOccupation(null)}
              onRelease={handleRelease}
            />
          )}
          {!occupation && (
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
