import { PublicDevice } from './api';

interface DeviceCardProps {
  readonly device: PublicDevice;
  readonly isMine: boolean;
  readonly onOccupy: (deviceId: string) => void;
  readonly onRelease: () => void;
}

/** 상태 도트 색 — online+ready 초록, online 준비중 노랑, offline 회색 */
function dotColor(device: PublicDevice): string {
  if (device.status !== 'online') return 'gray';
  if (device.tags.includes('controller-ready')) return 'green';
  return 'amber';
}

export function DeviceCard({ device, isMine, onOccupy, onRelease }: DeviceCardProps) {
  const isReady = device.tags.includes('controller-ready');
  const canOccupy = device.status === 'online' && !device.isOccupied;

  return (
    <div className={isMine ? 'device-card active' : 'device-card'}>
      <div className="name-row">
        <span className={`dot ${dotColor(device)}`} />
        <span className="name">{device.name}</span>
      </div>
      <div className="meta">
        iOS {device.osVersion} · {device.status}
      </div>
      <div className="badges">
        {isReady && <span className="badge ready">controller ready</span>}
        {device.isOccupied && <span className="badge occupied">점유 중</span>}
        {device.tags
          .filter((tag) => tag !== 'controller-ready')
          .map((tag) => (
            <span key={tag} className="badge">
              {tag}
            </span>
          ))}
      </div>
      {!isMine && (
        <button className="btn primary" disabled={!canOccupy} onClick={() => onOccupy(device.id)}>
          점유
        </button>
      )}
      {isMine && (
        <button className="btn danger" onClick={onRelease}>
          해제
        </button>
      )}
    </div>
  );
}
