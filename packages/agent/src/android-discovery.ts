import { isDeviceId, RegisterDeviceInput } from '@nebula/shared';
import { AdbClient } from './adb-client';
import { DiscoverySource } from './discovery-source';
import { logger } from './logger';

/** adb devices -l 한 줄 파싱 결과 */
export interface AdbDeviceEntry {
  readonly serial: string;
  readonly state: string;
  readonly model: string | null;
}

/** `SERIAL  STATE key:value ...` 형식 파싱 — 헤더·빈 줄 스킵 (순수 함수) */
export function parseAdbDevices(stdout: string): readonly AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('*')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...attributes] = parts;
    const model = attributes
      .find((attribute) => attribute.startsWith('model:'))
      ?.slice('model:'.length)
      .replace(/_/g, ' ');
    entries.push({ serial, state, model: model ?? null });
  }
  return entries;
}

/**
 * adb 기반 Android 기기 발견 — devicectl(iOS 소스)과 동일 계약:
 * 전체 실패(adb 미기동 등)만 null, 기기 없음은 []
 */
export class AndroidDiscoverySource implements DiscoverySource {
  readonly platform = 'android' as const;

  /** serial → osVersion 캐시 — 발견 주기(20초)마다 getprop N회 호출 회피 */
  private readonly osVersions = new Map<string, string>();
  /** 상태별 경고는 serial당 1회만 — 주기 로그 도배 방지 */
  private readonly warnedSerials = new Set<string>();

  constructor(private readonly adb: AdbClient) {}

  async discover(): Promise<readonly RegisterDeviceInput[] | null> {
    let raw: string;
    try {
      raw = await this.adb.listDevices();
    } catch (error) {
      logger.warn({ err: error }, 'adb 기기 목록 실패 — Android 발견 실패로 처리');
      return null;
    }

    const entries = parseAdbDevices(raw);
    const activeSerials = new Set(entries.map((entry) => entry.serial));
    this.pruneCaches(activeSerials);

    const devices: RegisterDeviceInput[] = [];
    for (const entry of entries) {
      const device = await this.toRegisterInput(entry);
      if (device) devices.push(device);
    }
    return devices;
  }

  private pruneCaches(activeSerials: ReadonlySet<string>): void {
    for (const serial of [...this.osVersions.keys()]) {
      if (!activeSerials.has(serial)) this.osVersions.delete(serial);
    }
    for (const serial of [...this.warnedSerials]) {
      if (!activeSerials.has(serial)) this.warnedSerials.delete(serial);
    }
  }

  private async toRegisterInput(entry: AdbDeviceEntry): Promise<RegisterDeviceInput | null> {
    if (entry.state !== 'device') {
      this.warnOnce(entry.serial, `adb 기기 상태 ${entry.state} — 기기에서 USB 디버깅 허용 필요`);
      return null;
    }
    // 무선 adb serial(host:port)은 서버 deviceId 패턴 위반 → register 전체가 폐기됨
    if (!isDeviceId(entry.serial)) {
      this.warnOnce(entry.serial, '무선 adb serial 미지원 — USB 연결 필요');
      return null;
    }

    return {
      id: entry.serial,
      name: entry.model ?? entry.serial,
      platform: 'android',
      osVersion: await this.resolveOsVersion(entry.serial),
      tags: [],
    };
  }

  private async resolveOsVersion(serial: string): Promise<string> {
    const cached = this.osVersions.get(serial);
    if (cached) return cached;
    try {
      const version = await this.adb.getProp(serial, 'ro.build.version.release');
      if (version.length === 0) return 'unknown';
      this.osVersions.set(serial, version);
      return version;
    } catch (error) {
      logger.warn({ err: error, serial }, 'Android OS 버전 조회 실패 — unknown으로 등록');
      return 'unknown';
    }
  }

  private warnOnce(serial: string, message: string): void {
    if (this.warnedSerials.has(serial)) return;
    this.warnedSerials.add(serial);
    logger.warn({ serial }, message);
  }
}
