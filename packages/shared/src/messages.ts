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
  /**
   * 이 명령을 낸 점유 세대 — 서버가 전송 직전 검증한 값.
   * Agent는 큐에서 꺼낼 때 이 값으로 재확인해 인계 이후의 유령 입력을 막는다
   */
  readonly occupantId: string;
  readonly action: DeviceAction;
}

/** 점유 종료 통지 — 그 세대의 대기 명령을 Agent가 폐기하게 함 */
export interface OccupancyEndedMessage {
  readonly type: 'occupancyEnded';
  readonly deviceId: string;
  readonly occupantId: string;
}

/**
 * 미러링 수요 스냅샷 — 이 Agent 소속 기기 중 "지금 시청자가 붙어 있는" 기기 전체 목록.
 * 부분 갱신이 아니라 매번 전체를 보내므로 유실·순서 뒤바뀜에도 상태가 어긋나지 않는다.
 * Agent는 캡처는 유지(pre-warm)하되, 목록에 없는 기기의 프레임은 터널로 보내지 않는다
 */
export interface StreamDemandMessage {
  readonly type: 'streamDemand';
  readonly deviceIds: readonly string[];
}

export type ServerMessage = CommandMessage | OccupancyEndedMessage | StreamDemandMessage;

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
  occupantId: string,
  action: DeviceAction,
): CommandMessage {
  return { type: 'command', requestId, deviceId, occupantId, action };
}

export function buildStreamDemandMessage(
  deviceIds: readonly string[],
): StreamDemandMessage {
  return { type: 'streamDemand', deviceIds };
}

export function buildOccupancyEndedMessage(
  deviceId: string,
  occupantId: string,
): OccupancyEndedMessage {
  return { type: 'occupancyEnded', deviceId, occupantId };
}

export function buildCommandResultMessage(
  requestId: string,
  outcome: CommandOutcome,
): CommandResultMessage {
  return { type: 'commandResult', requestId, outcome };
}
