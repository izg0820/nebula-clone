/** 서버 API 클라이언트 — 모든 호출은 Bearer 토큰 필수 */

export interface PublicDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly tags: readonly string[];
  readonly status: 'online' | 'offline';
  readonly isOccupied: boolean;
}

export interface OccupyResponse {
  readonly occupantId: string;
  readonly device: PublicDevice;
}

export interface ScreenshotResult {
  readonly jpegBase64: string;
  readonly widthPt: number;
  readonly heightPt: number;
}

/** 상태 코드를 보존하는 API 오류 — 403(점유 무효) 같은 종료 조건 판별용 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  listDevices(): Promise<PublicDevice[]> {
    return this.request('GET', '/devices');
  }

  occupy(deviceId: string): Promise<OccupyResponse> {
    return this.request('POST', '/devices/occupy', { deviceId });
  }

  release(deviceId: string, occupantId: string): Promise<PublicDevice> {
    return this.request('POST', `/devices/${deviceId}/release`, { occupantId });
  }

  async tap(deviceId: string, occupantId: string, x: number, y: number): Promise<void> {
    await this.request('POST', `/devices/${deviceId}/actions/tap`, { occupantId, x, y });
  }

  async typeText(deviceId: string, occupantId: string, text: string): Promise<void> {
    await this.request('POST', `/devices/${deviceId}/actions/type`, { occupantId, text });
  }

  async swipe(
    deviceId: string,
    occupantId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    await this.request('POST', `/devices/${deviceId}/actions/swipe`, {
      occupantId,
      fromX,
      fromY,
      toX,
      toY,
      durationMs,
    });
  }

  async pressButton(deviceId: string, occupantId: string, button: 'home'): Promise<void> {
    await this.request('POST', `/devices/${deviceId}/actions/press`, { occupantId, button });
  }

  async screenshot(deviceId: string, occupantId: string): Promise<ScreenshotResult> {
    const response = await this.request<{ result: ScreenshotResult }>(
      'POST',
      `/devices/${deviceId}/actions/screenshot`,
      { occupantId },
    );
    return response.result;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ApiError(response.status, `${method} ${path} → ${response.status} ${detail.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }
}
