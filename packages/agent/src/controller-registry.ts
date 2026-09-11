/** 기기 → Controller 주소 해석 — iOS·Android 수퍼바이저가 공통 구현 */
export interface ControllerEndpointResolver {
  /** 기기의 Controller baseUrl (미등록 시 null) */
  resolve(deviceId: string): string | null;
  /** Controller가 명령을 받을 준비가 됐는지 */
  isReady(deviceId: string): boolean;
}
