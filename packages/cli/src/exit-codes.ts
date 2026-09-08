/** 종료 코드 규약 — 스크립트가 실패 종류를 분기할 수 있게 고정 */
export const EXIT_OK = 0;
/** 네트워크·타임아웃·예상 못한 예외 */
export const EXIT_FAILURE = 1;
/** 알 수 없는 커맨드·필수 플래그 누락·값 형식 오류 */
export const EXIT_USAGE = 2;
/** 401·403·429 — 토큰·점유 권한 문제 */
export const EXIT_AUTH = 3;
/** 404·409 — 대상 없음·충돌 */
export const EXIT_NOT_FOUND = 4;
/** 502·504 — Agent·기기 게이트웨이 실패 */
export const EXIT_GATEWAY = 5;

const STATUS_EXIT_CODES: Record<number, number> = {
  401: EXIT_AUTH,
  403: EXIT_AUTH,
  429: EXIT_AUTH,
  404: EXIT_NOT_FOUND,
  409: EXIT_NOT_FOUND,
  502: EXIT_GATEWAY,
  504: EXIT_GATEWAY,
};

export function statusToExitCode(status: number): number {
  return STATUS_EXIT_CODES[status] ?? EXIT_FAILURE;
}

/** 사용법 오류 — 메시지를 stderr로 내고 EXIT_USAGE로 종료 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
