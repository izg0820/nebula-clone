import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { logger } from './logger';
import { RegisterDeviceInput } from './messages';

const execFileAsync = promisify(execFile);

/** devicectl JSON에서 안전하게 중첩 필드 접근 */
function getRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null) return null;
  return child as Record<string, unknown>;
}

function getString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'string') return null;
  return child;
}

/** devicectl 디바이스 항목 → 등록 정보 변환 (iPhone/iPad 외·필드 누락 시 null) */
function toRegisterInput(entry: unknown): RegisterDeviceInput | null {
  const hardware = getRecord(entry, 'hardwareProperties');
  const properties = getRecord(entry, 'deviceProperties');
  const udid = getString(hardware, 'udid');
  const name = getString(properties, 'name');
  const osVersion = getString(properties, 'osVersionNumber');
  const platformId = getString(properties, 'platformIdentifier') ?? '';

  if (!udid || !name || !osVersion) return null;
  if (!platformId.includes('iphoneos') && !platformId.includes('ipados')) return null;

  return { id: udid, name, platform: 'ios', osVersion, tags: [] };
}

/** 페어링된 기기만 등록 대상 (미페어링 기기는 제어 불가) */
function isPaired(entry: unknown): boolean {
  const connection = getRecord(entry, 'connectionProperties');
  return getString(connection, 'pairingState') === 'paired';
}

/** `devicectl list devices --json-output` 결과 파싱 — 형식 불일치는 빈 배열 */
export function parseDevicectlOutput(json: unknown): RegisterDeviceInput[] {
  const result = getRecord(json, 'result');
  if (!result || !Array.isArray(result.devices)) return [];

  return result.devices
    .filter(isPaired)
    .map(toRegisterInput)
    .filter((device): device is RegisterDeviceInput => device !== null);
}

/**
 * USB 연결된 iOS 기기 발견 — devicectl 부재·실패 시 빈 배열 (치명적이지 않음)
 * devicectl은 JSON을 파일로만 출력하므로 임시 파일 경유
 */
export async function discoverDevices(): Promise<RegisterDeviceInput[]> {
  const outputPath = join(tmpdir(), `nebula-devicectl-${randomUUID()}.json`);
  try {
    await execFileAsync('xcrun', ['devicectl', 'list', 'devices', '--json-output', outputPath], {
      timeout: 15_000,
    });
    const raw = await readFile(outputPath, 'utf8');
    return parseDevicectlOutput(JSON.parse(raw) as unknown);
  } catch (error) {
    logger.warn({ err: error }, '기기 발견 실패 — 빈 목록으로 진행 (Xcode 미설치·기기 미연결 가능)');
    return [];
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}
