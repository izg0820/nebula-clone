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

/** 기기 명령 응답 대기 상한 (ms) — 초과 시 클라이언트에 504 */
export const COMMAND_TIMEOUT_MS = 15_000;

/** 미러링 시청자 WS 경로 */
export const STREAM_WS_PATH = '/stream';

/** Agent 터널 메시지 상한 — 프레임(수백 KB)+여유. 손상·악성 Agent의 메모리 압박 방지 */
export const AGENT_WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** 시청자는 수신 전용 — 보내는 메시지가 없어야 정상 */
export const VIEWER_WS_MAX_PAYLOAD_BYTES = 16 * 1024;
