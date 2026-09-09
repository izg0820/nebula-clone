/** 러너 헬스체크 HTTP 응답 대기 상한 */
export const HEALTH_TIMEOUT_MS = 5_000;

function toTokenHeaders(controllerToken: string | null): Record<string, string> {
  if (!controllerToken) return {};
  return { 'x-nebula-token': controllerToken };
}

/** Controller HTTP 계약의 /health 폴러 — iOS(XCUITest)·Android(instrumentation) 러너 공용 */
export function makeControllerHealthCheck(
  controllerToken: string | null,
): (baseUrl: string) => Promise<boolean> {
  const headers = toTokenHeaders(controllerToken);
  return async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
