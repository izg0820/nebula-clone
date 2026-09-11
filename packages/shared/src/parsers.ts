import { CommandOutcome, DeviceAction, isHardwareButton } from './actions';
import { isDevicePlatform, RegisterDeviceInput } from './device';
import { AgentMessage, ServerMessage } from './messages';

/** 신뢰 경계의 수신 JSON 검증 파서 — 형식 불일치는 null (throw 금지) */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** deviceId(UDID) 허용 형식 — URL 경로 삽입·로그 인젝션 방지 (경로 구분자·제어문자 배제) */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

function isRegisterDevice(value: unknown): value is RegisterDeviceInput {
  const record = asRecord(value);
  if (!record) return false;
  return (
    isDeviceId(record.id) &&
    typeof record.name === 'string' &&
    isDevicePlatform(record.platform) &&
    typeof record.osVersion === 'string' &&
    Array.isArray(record.tags) &&
    record.tags.every((tag: unknown) => typeof tag === 'string')
  );
}

function isCommandOutcome(value: unknown): value is CommandOutcome {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) return true;
  return record.ok === false && typeof record.error === 'string';
}

/** 좌표 액션 필드가 유한 수인지 확인 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDeviceAction(value: unknown): value is DeviceAction {
  const record = asRecord(value);
  if (!record) return false;
  if (record.kind === 'tap') return isFiniteNumber(record.x) && isFiniteNumber(record.y);
  if (record.kind === 'swipe') {
    return (
      isFiniteNumber(record.fromX) &&
      isFiniteNumber(record.fromY) &&
      isFiniteNumber(record.toX) &&
      isFiniteNumber(record.toY) &&
      isFiniteNumber(record.durationMs)
    );
  }
  if (record.kind === 'typeText') return typeof record.text === 'string';
  if (record.kind === 'screenshot') return true;
  if (record.kind === 'pressButton') return isHardwareButton(record.button);
  return record.kind === 'uiDump';
}

/** Agent → 서버 메시지 파싱 */
export function parseAgentMessage(raw: string): AgentMessage | null {
  const message = parseJson(raw);
  if (!message) return null;

  if (message.type === 'register' && Array.isArray(message.devices)) {
    if (!message.devices.every(isRegisterDevice)) return null;
    if (message.capabilities === undefined) {
      return { type: 'register', devices: message.devices as RegisterDeviceInput[] };
    }
    if (
      !Array.isArray(message.capabilities) ||
      !message.capabilities.every((kind: unknown) => typeof kind === 'string')
    ) {
      return null;
    }
    return {
      type: 'register',
      devices: message.devices as RegisterDeviceInput[],
      capabilities: message.capabilities as string[],
    };
  }
  if (
    message.type === 'heartbeat' &&
    Array.isArray(message.deviceIds) &&
    message.deviceIds.every((id: unknown) => typeof id === 'string')
  ) {
    return { type: 'heartbeat', deviceIds: message.deviceIds as string[] };
  }
  if (
    message.type === 'commandResult' &&
    isRequestId(message.requestId) &&
    isCommandOutcome(message.outcome)
  ) {
    return { type: 'commandResult', requestId: message.requestId, outcome: message.outcome };
  }
  return null;
}

/** requestId 허용 형식 (UUID 계열) — 로그 인젝션·비정상 키 방지 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** occupantId 허용 형식 — 서버가 randomUUID로 발급 (로그 인젝션·비정상 키 방지) */
const OCCUPANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function isOccupantId(value: unknown): value is string {
  return typeof value === 'string' && OCCUPANT_ID_PATTERN.test(value);
}

/** 서버 → Agent 메시지 파싱 */
export function parseServerMessage(raw: string): ServerMessage | null {
  const message = parseJson(raw);
  if (!message) return null;

  if (
    message.type === 'command' &&
    isRequestId(message.requestId) &&
    isDeviceId(message.deviceId) &&
    isOccupantId(message.occupantId) &&
    isDeviceAction(message.action)
  ) {
    return {
      type: 'command',
      requestId: message.requestId,
      deviceId: message.deviceId,
      occupantId: message.occupantId,
      action: message.action,
    };
  }
  if (
    message.type === 'occupancyEnded' &&
    isDeviceId(message.deviceId) &&
    isOccupantId(message.occupantId)
  ) {
    return {
      type: 'occupancyEnded',
      deviceId: message.deviceId,
      occupantId: message.occupantId,
    };
  }
  return null;
}
