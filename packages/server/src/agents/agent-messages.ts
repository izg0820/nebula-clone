import { RegisterDeviceInput } from '../devices/device.types';

/** Agent → 서버 WS 메시지 프로토콜 */

export interface RegisterMessage {
  readonly type: 'register';
  readonly devices: readonly RegisterDeviceInput[];
}

export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly deviceIds: readonly string[];
}

export type AgentMessage = RegisterMessage | HeartbeatMessage;

/** 수신 JSON 파싱 + 형태 검증 (불일치 시 null) */
export function parseAgentMessage(raw: string): AgentMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const message = parsed as Record<string, unknown>;
  if (message.type === 'register' && Array.isArray(message.devices)) {
    const isValid = message.devices.every(
      (device: unknown) =>
        typeof device === 'object' &&
        device !== null &&
        typeof (device as Record<string, unknown>).id === 'string' &&
        typeof (device as Record<string, unknown>).name === 'string' &&
        (device as Record<string, unknown>).platform === 'ios' &&
        typeof (device as Record<string, unknown>).osVersion === 'string' &&
        Array.isArray((device as Record<string, unknown>).tags),
    );
    if (!isValid) return null;
    return { type: 'register', devices: message.devices as RegisterDeviceInput[] };
  }
  if (
    message.type === 'heartbeat' &&
    Array.isArray(message.deviceIds) &&
    message.deviceIds.every((id: unknown) => typeof id === 'string')
  ) {
    return { type: 'heartbeat', deviceIds: message.deviceIds as string[] };
  }
  return null;
}
