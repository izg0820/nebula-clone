import { ApiError } from './api-error';
import { DEFAULT_TIMEOUT_MS, defaultFetch, FetchLike } from './http-client';
import {
  DeviceTarget,
  HardwareButton,
  HealthStatus,
  KeepaliveResponse,
  OccupyRequest,
  OccupyResponse,
  PublicDevice,
  ScreenshotResult,
  SwipeGesture,
  TapPoint,
  UiDumpResult,
} from './types';

/** 스와이프 기본 시간 (ms) — 서버 기본값과 동일 */
const DEFAULT_SWIPE_DURATION_MS = 300;

export interface NebulaClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  /** 전송 계층 주입 — 미지정 시 globalThis.fetch */
  readonly fetchImpl?: FetchLike;
}

/** Nebula 서버 SDK — 웹 콘솔·CLI 공용. 타입은 openapi.json에서 생성 (스펙이 단일 진실) */
export class NebulaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: NebulaClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  health(): Promise<HealthStatus> {
    return this.request('GET', '/health');
  }

  listDevices(): Promise<PublicDevice[]> {
    return this.request('GET', '/devices');
  }

  getDevice(deviceId: string): Promise<PublicDevice> {
    return this.request('GET', `/devices/${encodeURIComponent(deviceId)}`);
  }

  occupy(filter: OccupyRequest = {}): Promise<OccupyResponse> {
    return this.request('POST', '/devices/occupy', filter);
  }

  release(deviceId: string, occupantId: string): Promise<PublicDevice> {
    return this.request('POST', `/devices/${encodeURIComponent(deviceId)}/release`, {
      occupantId,
    });
  }

  /** 점유 활동 연장 (sliding TTL) — 명령 없이 오래 점유할 때 주기 호출 */
  keepalive(deviceId: string, occupantId: string): Promise<KeepaliveResponse> {
    return this.request('POST', `/devices/${encodeURIComponent(deviceId)}/keepalive`, {
      occupantId,
    });
  }

  async tap(target: DeviceTarget, point: TapPoint): Promise<void> {
    await this.action(target, 'tap', { x: point.x, y: point.y });
  }

  async swipe(target: DeviceTarget, gesture: SwipeGesture): Promise<void> {
    await this.action(target, 'swipe', {
      fromX: gesture.fromX,
      fromY: gesture.fromY,
      toX: gesture.toX,
      toY: gesture.toY,
      durationMs: gesture.durationMs ?? DEFAULT_SWIPE_DURATION_MS,
    });
  }

  async typeText(target: DeviceTarget, text: string): Promise<void> {
    await this.action(target, 'type', { text });
  }

  async pressButton(target: DeviceTarget, button: HardwareButton): Promise<void> {
    await this.action(target, 'press', { button });
  }

  async uiDump(target: DeviceTarget): Promise<string> {
    const response = await this.action<{ result: UiDumpResult }>(target, 'ui-dump', {});
    return response.result.tree;
  }

  async screenshot(target: DeviceTarget): Promise<ScreenshotResult> {
    const response = await this.action<{ result: ScreenshotResult }>(target, 'screenshot', {});
    return response.result;
  }

  private action<T>(
    target: DeviceTarget,
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.request(
      'POST',
      `/devices/${encodeURIComponent(target.deviceId)}/actions/${name}`,
      { occupantId: target.occupantId, ...body },
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      // 응답 없는 서버(TCP 블랙홀)에 요청이 무한 적체되지 않게
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ApiError(
        response.status,
        `${method} ${path} → ${response.status} ${detail.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  }
}
