/** 서버 전역 상수 */

/** 하트비트 미수신 시 오프라인 판정 기준 (ms) */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** 기본 서버 포트 */
export const DEFAULT_PORT = 3000;

/** SQLite 기본 경로 */
export const DEFAULT_DB_PATH = './nebula.sqlite';

/** Agent WS 터널 경로 */
export const AGENT_WS_PATH = '/agent';

/** IP당 분당 요청 상한 (무차별 토큰 대입 완화) */
export const RATE_LIMIT_PER_MINUTE = 120;
