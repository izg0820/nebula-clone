import { DevicePlatform, DeviceTarget, NebulaClient, platformLabel, PublicDevice } from '@nebula/client';
import { CliFlags } from './args';
import { EXIT_OK, UsageError } from './exit-codes';
import { SessionStore } from './session-store';

/** 커맨드가 쓰는 클라이언트 표면 — 구조적 부분집합이라 테스트 fake가 쉬움 */
export type FarmClient = Pick<
  NebulaClient,
  | 'health'
  | 'listDevices'
  | 'getDevice'
  | 'occupy'
  | 'release'
  | 'keepalive'
  | 'tap'
  | 'swipe'
  | 'typeText'
  | 'pressButton'
  | 'uiDump'
  | 'screenshot'
>;

export interface CommandContext {
  readonly client: FarmClient;
  readonly flags: CliFlags;
  readonly serverUrl: string;
  readonly env: Record<string, string | undefined>;
  readonly session: SessionStore;
  readonly stdout: (line: string) => void;
  readonly saveFile: (path: string, data: Uint8Array) => void;
}

export type CommandHandler = (context: CommandContext) => Promise<number>;

/** --json이면 원문 JSON 한 줄, 아니면 사람용 요약 */
function emit(context: CommandContext, humanLines: readonly string[], jsonValue: unknown): void {
  if (context.flags.json) {
    context.stdout(JSON.stringify(jsonValue));
    return;
  }
  for (const line of humanLines) context.stdout(line);
}

function requireFlag<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new UsageError(`--${name} 필요`);
  return value;
}

/** 저장 세션은 같은 서버의 것만 유효 (다른 서버의 occupantId 오용 방지) */
function sessionFor(context: CommandContext) {
  const stored = context.session.load();
  if (!stored) return null;
  if (stored.serverUrl !== context.serverUrl) return null;
  return stored;
}

/** 세션 occupantId — 대상 기기와 일치할 때만 유효 */
function occupantFromSession(
  stored: { deviceId: string; occupantId: string } | null,
  deviceId: string,
): string | undefined {
  if (!stored) return undefined;
  if (stored.deviceId !== deviceId) return undefined;
  return stored.occupantId;
}

/** 대상 해석 — occupantId: 플래그 > env > 세션, deviceId: 플래그 > 세션 */
export function resolveTarget(context: CommandContext): DeviceTarget {
  const stored = sessionFor(context);
  const deviceId = context.flags.deviceId ?? stored?.deviceId;
  if (!deviceId) {
    throw new UsageError('대상 기기 없음 — --device-id를 넘기거나 먼저 devices occupy 실행');
  }

  const occupantId =
    context.flags.occupantId ??
    context.env.NEBULA_OCCUPANT_ID ??
    occupantFromSession(stored, deviceId);
  if (!occupantId) {
    throw new UsageError(
      '점유자 ID 없음 — 먼저 devices occupy를 실행하거나 --occupant-id(또는 NEBULA_OCCUPANT_ID)를 지정',
    );
  }
  return { deviceId, occupantId };
}

function statusDot(device: PublicDevice): string {
  if (device.status === 'online') return '●';
  return '○';
}

function occupiedSuffix(device: PublicDevice): string {
  if (device.isOccupied) return ' [점유중]';
  return '';
}

function tagsSuffix(device: PublicDevice): string {
  if (device.tags.length === 0) return '';
  return ` (${device.tags.join(', ')})`;
}

function deviceLine(device: PublicDevice): string {
  return `${statusDot(device)} ${device.id}  ${device.name}  ${platformLabel(device.platform)} ${device.osVersion}${tagsSuffix(device)}${occupiedSuffix(device)}`;
}

async function runHealth(context: CommandContext): Promise<number> {
  const result = await context.client.health();
  emit(context, [result.status], result);
  return EXIT_OK;
}

async function runDevicesList(context: CommandContext): Promise<number> {
  const devices = await context.client.listDevices();
  if (devices.length === 0) {
    emit(context, ['등록된 기기 없음'], devices);
    return EXIT_OK;
  }
  emit(context, devices.map(deviceLine), devices);
  return EXIT_OK;
}

async function runDevicesGet(context: CommandContext): Promise<number> {
  const deviceId = requireFlag(context.flags.deviceId, 'device-id');
  const device = await context.client.getDevice(deviceId);
  emit(context, [deviceLine(device)], device);
  return EXIT_OK;
}

function toMutableTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return [...tags];
}

async function runOccupy(context: CommandContext): Promise<number> {
  const result = await context.client.occupy({
    deviceId: context.flags.deviceId,
    platform: context.flags.platform as DevicePlatform | undefined,
    tags: toMutableTags(context.flags.tags),
  });
  context.session.save({
    serverUrl: context.serverUrl,
    deviceId: result.device.id,
    occupantId: result.occupantId,
    occupiedAt: new Date().toISOString(),
  });
  emit(
    context,
    [
      `점유됨: ${result.device.id} (${result.device.name})`,
      `occupantId: ${result.occupantId}`,
      `만료 예정: ${result.expiresAt ?? '-'} (명령·keepalive 활동 시 연장)`,
      '세션 저장됨 — 이후 커맨드는 --device-id/--occupant-id 생략 가능',
    ],
    result,
  );
  return EXIT_OK;
}

async function runRelease(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  const device = await context.client.release(target.deviceId, target.occupantId);
  const stored = sessionFor(context);
  if (stored?.deviceId === target.deviceId) context.session.clear();
  emit(context, [`해제됨: ${device.id}`], device);
  return EXIT_OK;
}

async function runKeepalive(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  const result = await context.client.keepalive(target.deviceId, target.occupantId);
  emit(context, [`연장됨 — 만료 예정: ${result.expiresAt ?? '-'}`], result);
  return EXIT_OK;
}

async function runSession(context: CommandContext): Promise<number> {
  if (context.flags.clear) {
    context.session.clear();
    emit(context, ['세션 삭제됨'], { cleared: true });
    return EXIT_OK;
  }
  const stored = context.session.load();
  if (!stored) {
    emit(context, ['저장된 세션 없음'], null);
    return EXIT_OK;
  }
  emit(
    context,
    [`기기: ${stored.deviceId}`, `서버: ${stored.serverUrl}`, `점유 시각: ${stored.occupiedAt}`],
    stored,
  );
  return EXIT_OK;
}

async function runTap(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  await context.client.tap(target, {
    x: requireFlag(context.flags.x, 'x'),
    y: requireFlag(context.flags.y, 'y'),
  });
  emit(context, ['ok'], { ok: true });
  return EXIT_OK;
}

async function runSwipe(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  await context.client.swipe(target, {
    fromX: requireFlag(context.flags.fromX, 'from-x'),
    fromY: requireFlag(context.flags.fromY, 'from-y'),
    toX: requireFlag(context.flags.toX, 'to-x'),
    toY: requireFlag(context.flags.toY, 'to-y'),
    durationMs: context.flags.durationMs,
  });
  emit(context, ['ok'], { ok: true });
  return EXIT_OK;
}

async function runType(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  await context.client.typeText(target, requireFlag(context.flags.text, 'text'));
  emit(context, ['ok'], { ok: true });
  return EXIT_OK;
}

async function runPress(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  const button = requireFlag(context.flags.button, 'button');
  if (button !== 'home' && button !== 'back') {
    throw new UsageError(`--button은 home|back 지원: ${button} (back은 Android 전용)`);
  }
  await context.client.pressButton(target, button);
  emit(context, ['ok'], { ok: true });
  return EXIT_OK;
}

async function runUiDump(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  const tree = await context.client.uiDump(target);
  if (context.flags.out) {
    context.saveFile(context.flags.out, new TextEncoder().encode(tree));
    emit(context, [`저장됨: ${context.flags.out}`], { saved: context.flags.out });
    return EXIT_OK;
  }
  emit(context, [tree], { tree });
  return EXIT_OK;
}

async function runScreenshot(context: CommandContext): Promise<number> {
  const target = resolveTarget(context);
  const result = await context.client.screenshot(target);
  if (context.flags.out) {
    const bytes = Uint8Array.from(Buffer.from(result.jpegBase64, 'base64'));
    context.saveFile(context.flags.out, bytes);
    emit(
      context,
      [`저장됨: ${context.flags.out} (${result.coordWidth}x${result.coordHeight})`],
      { saved: context.flags.out, coordWidth: result.coordWidth, coordHeight: result.coordHeight },
    );
    return EXIT_OK;
  }
  if (context.flags.json) {
    emit(context, [], result);
    return EXIT_OK;
  }
  // base64를 터미널에 쏟지 않음 — 저장 경로를 요구
  throw new UsageError('screenshot은 --out <파일> 또는 --json 필요 (base64를 stdout에 쏟지 않음)');
}

/** 커맨드 라우팅 — 객체 맵 (switch 금지 컨벤션) */
export const COMMANDS: Record<string, CommandHandler> = {
  health: runHealth,
  'devices list': runDevicesList,
  'devices get': runDevicesGet,
  'devices occupy': runOccupy,
  'devices release': runRelease,
  'devices keepalive': runKeepalive,
  'devices session': runSession,
  tap: runTap,
  swipe: runSwipe,
  type: runType,
  press: runPress,
  'ui-dump': runUiDump,
  screenshot: runScreenshot,
};
