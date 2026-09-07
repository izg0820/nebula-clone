import { homedir, hostname } from 'os';
import { join } from 'path';
import { RegisterDeviceInput } from '@nebula/shared';

/** Agent 설정 */
export interface AgentConfig {
  /** 서버 WS 터널 주소 (예: ws://host:3000/agent) */
  readonly serverUrl: string;
  readonly agentToken: string;
  /** 서버 게이트웨이 형식 [A-Za-z0-9_-]{1,64} 준수 */
  readonly agentId: string;
  readonly discoveryIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  /** 기기 UDID → Controller HTTP 포트 (정적 설정 — 러너 수동 기동 모드) */
  readonly controllerPorts: ReadonlyMap<string, number>;
  /** devicectl 없이 등록할 정적 기기 목록 (개발·파이프라인 검증용) */
  readonly staticDevices: readonly RegisterDeviceInput[];
  /** xcodebuild 수퍼바이저 설정 (null이면 정적 포트 모드) */
  readonly supervisor: SupervisorEnvConfig | null;
  /** mirror-helper 바이너리 경로 — 지정 시 H.264 미러링, 미지정 시 JPEG 폴백 */
  readonly mirrorHelperPath: string | null;
}

/** 수퍼바이저 환경 설정 */
export interface SupervisorEnvConfig {
  readonly projectPath: string;
  readonly scheme: string;
  readonly basePort: number;
  readonly derivedDataDir: string;
  readonly logDir: string;
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

/** 'udid:8100,udid2:8101' → Map. 형식 오류 시 즉시 실패 */
export function parseControllerPorts(raw: string | undefined): ReadonlyMap<string, number> {
  const ports = new Map<string, number>();
  if (!raw || raw.trim().length === 0) return ports;

  for (const pair of raw.split(',')) {
    const [deviceId, portText] = pair.split(':').map((part) => part.trim());
    const port = Number(portText);
    if (!deviceId || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`NEBULA_CONTROLLER_PORTS 형식 오류: "${pair}" (udid:port,udid2:port)`);
    }
    ports.set(deviceId, port);
  }
  return ports;
}

/** 정적 기기 JSON 파싱 — 형식 오류 시 즉시 실패 (개발·검증용 입력이므로 관대하지 않음) */
export function parseStaticDevices(raw: string | undefined): readonly RegisterDeviceInput[] {
  if (!raw || raw.trim().length === 0) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('NEBULA_STATIC_DEVICES는 JSON 배열이어야 함');

  return parsed.map((entry: unknown): RegisterDeviceInput => {
    const record = entry as Record<string, unknown>;
    if (
      typeof record?.id !== 'string' ||
      typeof record?.name !== 'string' ||
      typeof record?.osVersion !== 'string'
    ) {
      throw new Error('NEBULA_STATIC_DEVICES 항목에 id/name/osVersion 필요');
    }
    return {
      id: record.id,
      name: record.name,
      platform: 'ios',
      osVersion: record.osVersion,
      tags: parseTags(record.tags),
    };
  });
}

/** tags 엄격 검증 — 비문자열이 섞이면 서버가 register 전체를 폐기하므로 기동 시점에 실패시킴 */
function parseTags(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((tag: unknown) => typeof tag !== 'string')) {
    throw new Error('NEBULA_STATIC_DEVICES tags는 문자열 배열이어야 함');
  }
  return raw as string[];
}

/** 수퍼바이저 기본값 */
const DEFAULT_SUPERVISOR_SCHEME = 'NebulaController';
const DEFAULT_SUPERVISOR_BASE_PORT = 8200;
/** 기기별 오프셋 여유를 둔 basePort 상한 */
const MAX_BASE_PORT = 65_000;

/** NEBULA_XCODEBUILD_ENABLED=true일 때 수퍼바이저 설정 로드 — 프로젝트 경로 필수 */
export function parseSupervisorConfig(env: NodeJS.ProcessEnv): SupervisorEnvConfig | null {
  if (env.NEBULA_XCODEBUILD_ENABLED !== 'true') return null;

  const projectPath = env.NEBULA_CONTROLLER_PROJECT;
  if (!projectPath || projectPath.trim().length === 0) {
    throw new Error('NEBULA_XCODEBUILD_ENABLED=true면 NEBULA_CONTROLLER_PROJECT(.xcodeproj 경로) 필수');
  }

  const basePort = parsePositiveInt(env.NEBULA_CONTROLLER_BASE_PORT, DEFAULT_SUPERVISOR_BASE_PORT);
  if (basePort > MAX_BASE_PORT) {
    throw new Error(`NEBULA_CONTROLLER_BASE_PORT는 ${MAX_BASE_PORT} 이하여야 함 (기기별 오프셋 여유)`);
  }

  const nebulaHome = join(homedir(), '.nebula');
  return {
    projectPath,
    scheme: env.NEBULA_CONTROLLER_SCHEME ?? DEFAULT_SUPERVISOR_SCHEME,
    basePort,
    derivedDataDir: env.NEBULA_DERIVED_DATA_DIR ?? join(nebulaHome, 'derived-data'),
    logDir: env.NEBULA_CONTROLLER_LOG_DIR ?? join(nebulaHome, 'logs'),
  };
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
    controllerPorts: parseControllerPorts(env.NEBULA_CONTROLLER_PORTS),
    staticDevices: parseStaticDevices(env.NEBULA_STATIC_DEVICES),
    supervisor: parseSupervisorConfig(env),
    mirrorHelperPath: env.NEBULA_MIRROR_HELPER ?? null,
  };
}
