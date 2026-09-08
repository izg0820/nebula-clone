/** 상태 코드를 보존하는 API 오류 — 403(점유 무효) 같은 종료 조건 판별용 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** unknown 오류 → 사용자 표시용 메시지 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
