interface SettingsPanelProps {
  readonly serverUrl: string;
  readonly token: string;
  readonly onServerUrlChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
}

/** 서버 주소·토큰 설정 — 사이드바 하단 고정 */
export function SettingsPanel({
  serverUrl,
  token,
  onServerUrlChange,
  onTokenChange,
}: SettingsPanelProps) {
  return (
    <div className="settings">
      <div className="section-title">연결 설정</div>
      <div className="field">
        <label>서버 주소</label>
        <input
          className="input"
          value={serverUrl}
          onChange={(event) => onServerUrlChange(event.target.value)}
        />
      </div>
      <div className="field">
        <label>클라이언트 토큰</label>
        <input
          className="input"
          type="password"
          value={token}
          placeholder="24자 이상 입력 시 연결"
          onChange={(event) => onTokenChange(event.target.value)}
        />
      </div>
    </div>
  );
}
