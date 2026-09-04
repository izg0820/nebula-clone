import { CommandOutcome, DeviceAction } from './actions';
import { RegisterDeviceInput } from './device';

/** Agent ↔ 서버 WS 터널 메시지 프로토콜 */

// ── Agent → 서버 ──────────────────────────────────────────

export interface RegisterMessage {
  readonly type: 'register';
  readonly devices: readonly RegisterDeviceInput[];
}

export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly deviceIds: readonly string[];
}

/** 서버가 보낸 command에 대한 응답 (requestId로 상관) */
export interface CommandResultMessage {
  readonly type: 'commandResult';
  readonly requestId: string;
  readonly outcome: CommandOutcome;
}

export type AgentMessage = RegisterMessage | HeartbeatMessage | CommandResultMessage;

// ── 서버 → Agent ──────────────────────────────────────────

export interface CommandMessage {
  readonly type: 'command';
  readonly requestId: string;
  readonly deviceId: string;
  readonly action: DeviceAction;
}

export type ServerMessage = CommandMessage;

// ── 빌더 ─────────────────────────────────────────────────

export function buildRegisterMessage(devices: readonly RegisterDeviceInput[]): RegisterMessage {
  return { type: 'register', devices };
}

export function buildHeartbeatMessage(deviceIds: readonly string[]): HeartbeatMessage {
  return { type: 'heartbeat', deviceIds };
}

export function buildCommandMessage(
  requestId: string,
  deviceId: string,
  action: DeviceAction,
): CommandMessage {
  return { type: 'command', requestId, deviceId, action };
}

export function buildCommandResultMessage(
  requestId: string,
  outcome: CommandOutcome,
): CommandResultMessage {
  return { type: 'commandResult', requestId, outcome };
}
