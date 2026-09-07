import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, PublicDevice } from './api';
import { ScreenView } from './ScreenView';

const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SERVER_URL = 'http://localhost:3000';

/** 점유 세션 (localStorage 보존 — 새로고침 시 유지) */
interface Occupation {
  readonly deviceId: string;
  readonly occupantId: string;
}

function loadStored(key: string): string {
  return localStorage.getItem(key) ?? '';
}

export function App() {
  const [serverUrl, setServerUrl] = useState(loadStored('serverUrl') || DEFAULT_SERVER_URL);
  const [token, setToken] = useState(loadStored('token'));
  const [devices, setDevices] = useState<PublicDevice[]>([]);
  const [occupation, setOccupation] = useState<Occupation | null>(() => {
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
  });
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

  // 기기 목록 폴링 — 토큰이 유효 길이(24자+)일 때만 (입력 중 타이핑마다 401 요청 방지)
  useEffect(() => {
    if (token.length < 24) return;
    let isActive = true;

    async function poll(): Promise<void> {
      try {
        const list = await api.listDevices();
        if (isActive) setDevices(list);
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
          setStatus(`점유됨: ${result.device.name}`);
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

  return (
    <div style={{ fontFamily: 'sans-serif', margin: 16, display: 'flex', gap: 24 }}>
      <div style={{ width: 380 }}>
        <h1 style={{ fontSize: 20 }}>Nebula Console</h1>
        <label>
          서버 주소
          <input
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          클라이언트 토큰
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            style={{ width: '100%' }}
          />
        </label>

        <h2 style={{ fontSize: 16 }}>기기 목록</h2>
        <ul style={{ paddingLeft: 0, listStyle: 'none' }}>
          {devices.map((device) => (
            <li key={device.id} style={{ marginBottom: 8, border: '1px solid #ddd', padding: 8 }}>
              <strong>{device.name}</strong> (iOS {device.osVersion}) — {device.status}
              {device.isOccupied && ' · 점유 중'}
              {device.tags.includes('controller-ready') && ' · ✅ ready'}
              <div>
                <button
                  disabled={device.status !== 'online' || device.isOccupied}
                  onClick={() => handleOccupy(device.id)}
                >
                  점유
                </button>
                {occupation?.deviceId === device.id && (
                  <button onClick={handleRelease}>해제</button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p style={{ color: '#c00', minHeight: 20 }}>{status}</p>
      </div>

      <div style={{ flex: 1 }}>
        {occupation && (
          <ScreenView
            api={api}
            serverUrl={serverUrl}
            token={token}
            deviceId={occupation.deviceId}
            occupantId={occupation.occupantId}
            onError={setStatus}
            onOccupationLost={() => setOccupation(null)}
          />
        )}
        {!occupation && <p>기기를 점유하면 화면이 표시됩니다.</p>}
      </div>
    </div>
  );
}
