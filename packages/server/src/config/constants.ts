/** 서버 전역 상수 */

/** 하트비트 미수신 시 오프라인 판정 기준 (ms) — env NEBULA_HEARTBEAT_TIMEOUT_MS로 조정 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** NEBULA_HEARTBEAT_TIMEOUT_MS 하한 — Agent 하트비트 주기(기본 25초)보다 짧으면 오탐 */
export const MIN_HEARTBEAT_TIMEOUT_MS = 10_000;

/** 스윕(하트비트 만료·점유 만료) 주기 (ms) — env NEBULA_SWEEP_INTERVAL_MS로 조정 */
export const SWEEP_INTERVAL_MS = 30_000;

/** NEBULA_SWEEP_INTERVAL_MS 하한 */
export const MIN_SWEEP_INTERVAL_MS = 1_000;

/** 선택적 ms env 해석 — 검증은 env.validation이 담당, 여기선 값만 채택 */
export function resolveMsEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  return Number(raw);
}

/** 점유 유휴 만료 기준 (ms) — occupy·명령·keepalive가 갱신, 초과 시 스윕이 회수 (sliding TTL) */
export const OCCUPATION_TTL_MS = 600_000;

/** NEBULA_OCCUPATION_TTL_MS 오버라이드 하한 — 웹 keepalive 주기(30초) 대비 최소 여유 */
export const MIN_OCCUPATION_TTL_MS = 60_000;

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

/** 시청자 강제 종료 코드 — 점유 종료 (4403 not occupant와 구분: 권한이 있었다가 끝난 상태) */
export const VIEWER_CLOSE_OCCUPATION_ENDED = 4408;
