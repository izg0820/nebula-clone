import { useState } from 'react';

interface SettingsPanelProps {
  readonly initialServerUrl: string;
  readonly initialToken: string;
  readonly isConnected: boolean;
  readonly onConnect: (serverUrl: string, token: string) => void;
  readonly onDisconnect: () => void;
}

const MIN_TOKEN_LENGTH = 24;

/**
 * 서버 주소·토큰 설정 + 명시적 연결 버튼 — 입력은 draft로만 두고 '연결' 클릭 시에만 적용.
 * (자동 연결 금지 — 잘못된 주소로 폴링이 계속 쏘이는 것 방지)
 */
export function SettingsPanel({
  initialServerUrl,
  initialToken,
  isConnected,
  onConnect,
  onDisconnect,
}: SettingsPanelProps) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [token, setToken] = useState(initialToken);

  const canConnect = serverUrl.trim().length > 0 && token.length >= MIN_TOKEN_LENGTH;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canConnect) return;
    onConnect(serverUrl.trim(), token);
  };

  return (
    <form className="settings" onSubmit={submit}>
      <div className="section-title">
        연결 설정
        <span className={`conn-dot ${isConnected ? 'on' : 'off'}`} title={isConnected ? '연결됨' : '미연결'} />
      </div>
      <div className="field">
        <label>서버 주소</label>
        <input
          className="input"
          value={serverUrl}
          disabled={isConnected}
          onChange={(event) => setServerUrl(event.target.value)}
        />
      </div>
      <div className="field">
        <label>클라이언트 토큰</label>
        <input
          className="input"
          type="password"
          value={token}
          disabled={isConnected}
          placeholder="24자 이상"
          onChange={(event) => setToken(event.target.value)}
        />
      </div>
      {!isConnected && (
        <button className="btn primary" type="submit" disabled={!canConnect}>
          연결
        </button>
      )}
      {isConnected && (
        <button className="btn" type="button" onClick={onDisconnect}>
          연결 해제
        </button>
      )}
    </form>
  );
}
