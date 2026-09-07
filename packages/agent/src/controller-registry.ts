/** 기기 → Controller 주소 해석 — 정적 설정과 수퍼바이저가 공통 구현 */
export interface ControllerEndpointResolver {
  /** 기기의 Controller baseUrl (미등록 시 null) */
  resolve(deviceId: string): string | null;
  /** Controller가 명령을 받을 준비가 됐는지 (정적 모드는 항상 true 간주) */
  isReady(deviceId: string): boolean;
}

/** NEBULA_CONTROLLER_PORTS 기반 정적 매핑 — 러너를 수동으로 띄우는 개발 모드 */
export class StaticControllerRegistry implements ControllerEndpointResolver {
  private readonly baseUrls = new Map<string, string>();

  constructor(controllerPorts: ReadonlyMap<string, number>) {
    for (const [deviceId, port] of controllerPorts) {
      this.baseUrls.set(deviceId, `http://127.0.0.1:${port}`);
    }
  }

  resolve(deviceId: string): string | null {
    return this.baseUrls.get(deviceId) ?? null;
  }

  isReady(deviceId: string): boolean {
    return this.baseUrls.has(deviceId);
  }
}
