/**
 * Agent → 서버 WS 메시지 프로토콜
 * 서버 측 정의(packages/server/src/agents/agent-messages.ts)와 동기 유지
 * TODO: 서버·에이전트 양쪽이 안정되면 @nebula/shared로 추출
 */

export interface RegisterDeviceInput {
  readonly id: string;
  readonly name: string;
  readonly platform: 'ios';
  readonly osVersion: string;
  readonly tags: readonly string[];
}

export interface RegisterMessage {
  readonly type: 'register';
  readonly devices: readonly RegisterDeviceInput[];
}

export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly deviceIds: readonly string[];
}

export function buildRegisterMessage(devices: readonly RegisterDeviceInput[]): RegisterMessage {
  return { type: 'register', devices };
}

export function buildHeartbeatMessage(deviceIds: readonly string[]): HeartbeatMessage {
  return { type: 'heartbeat', deviceIds };
}
