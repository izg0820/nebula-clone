import { CommandOutcome, DeviceAction } from './actions';
import { RegisterDeviceInput } from './device';

/** Agent ↔ 서버 WS 터널 메시지 프로토콜 */

// ── Agent → 서버 ──────────────────────────────────────────

export interface RegisterMessage {
  readonly type: 'register';
  readonly devices: readonly RegisterDeviceInput[];
  /** 이 Agent(+Controller 쌍)가 지원하는 액션 종류 — 스펙 미교환(구버전)이면 신규 액션 거부됨 */
  readonly capabilities?: readonly string[];
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

/** 미러링 스트림 시작 — 첫 시청자 진입 시 서버가 지시 */
export interface StartStreamMessage {
  readonly type: 'startStream';
  readonly deviceId: string;
}

/** 미러링 스트림 중지 — 마지막 시청자 퇴장 시 서버가 지시 */
export interface StopStreamMessage {
  readonly type: 'stopStream';
  readonly deviceId: string;
}

export type StreamControlMessage = StartStreamMessage | StopStreamMessage;
export type ServerMessage = CommandMessage | StreamControlMessage;

// ── 빌더 ─────────────────────────────────────────────────

export function buildRegisterMessage(
  devices: readonly RegisterDeviceInput[],
  capabilities?: readonly string[],
): RegisterMessage {
  if (capabilities === undefined) return { type: 'register', devices };
  return { type: 'register', devices, capabilities };
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

export function buildStreamControlMessage(
  shouldStart: boolean,
  deviceId: string,
): StreamControlMessage {
  if (shouldStart) return { type: 'startStream', deviceId };
  return { type: 'stopStream', deviceId };
}
