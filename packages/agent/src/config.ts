import { hostname } from 'os';

/** Agent 설정 */
export interface AgentConfig {
  /** 서버 WS 터널 주소 (예: ws://host:3000/agent) */
  readonly serverUrl: string;
  readonly agentToken: string;
  /** 서버 게이트웨이 형식 [A-Za-z0-9_-]{1,64} 준수 */
  readonly agentId: string;
  readonly discoveryIntervalMs: number;
  readonly heartbeatIntervalMs: number;
}

/** 서버 게이트웨이와 동일한 agentId 허용 형식 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_DISCOVERY_INTERVAL_MS = 20_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const MIN_TOKEN_LENGTH = 24;

/** 호스트명을 agentId 허용 형식으로 정규화 */
export function sanitizeAgentId(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (sanitized.length === 0) return 'agent';
  return sanitized;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`양의 정수가 아닌 값: ${raw}`);
  }
  return parsed;
}

/** 환경 변수 → 설정 로드. 누락·형식 오류 시 즉시 실패 */
export function loadConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const serverUrl = env.NEBULA_SERVER_URL;
  if (!serverUrl || !/^wss?:\/\//.test(serverUrl)) {
    throw new Error('NEBULA_SERVER_URL 누락 또는 ws://·wss:// 형식 아님');
  }

  const agentToken = env.NEBULA_AGENT_TOKEN;
  if (!agentToken || agentToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`NEBULA_AGENT_TOKEN 누락 또는 ${MIN_TOKEN_LENGTH}자 미만`);
  }

  const agentId = sanitizeAgentId(env.NEBULA_AGENT_ID ?? hostname());
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`agentId 형식 위반: ${agentId}`);
  }

  return {
    serverUrl,
    agentToken,
    agentId,
    discoveryIntervalMs: parsePositiveInt(
      env.NEBULA_DISCOVERY_INTERVAL_MS,
      DEFAULT_DISCOVERY_INTERVAL_MS,
    ),
    heartbeatIntervalMs: parsePositiveInt(
      env.NEBULA_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
  };
}
