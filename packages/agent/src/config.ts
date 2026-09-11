import { accessSync, constants } from 'fs';
import { homedir, hostname } from 'os';
import { join, resolve } from 'path';
import { DevicePlatform, isDevicePlatform, RegisterDeviceInput } from '@nebula/shared';

// 산출물 기본 경로 — Agent는 항상 레포 안에서 실행됨(dev.sh·daemon.sh·launchd) 전제.
// dist(빌드)·src(ts-node) 둘 다 packages/agent 하위라 3단계 상위가 레포 루트
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_RUNNER_APK = join(
  REPO_ROOT,
  'android-controller/runner/build/outputs/apk/debug/runner-debug.apk',
);
const DEFAULT_MIRROR_DEX = join(
  REPO_ROOT,
  'android-controller/mirror/build/outputs/apk/debug/mirror-debug.apk',
);
const DEFAULT_MIRROR_HELPER = join(REPO_ROOT, 'mirror-helper/.build/debug/mirror-helper');

/** Agent 설정 */
export interface AgentConfig {
  /** 서버 WS 터널 주소 (예: ws://host:3000/agent) */
  readonly serverUrl: string;
  readonly agentToken: string;
  /** 서버 게이트웨이 형식 [A-Za-z0-9_-]{1,64} 준수 */
  readonly agentId: string;
  readonly discoveryIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  /** devicectl 없이 등록할 정적 기기 목록 (개발·파이프라인 검증용) */
  readonly staticDevices: readonly RegisterDeviceInput[];
  /** xcodebuild 수퍼바이저 설정 (null이면 iOS 제어 비활성) */
  readonly supervisor: SupervisorEnvConfig | null;
  /** mirror-helper 바이너리 경로 — 미지정 시 레포 빌드 산출물 기본값 (미러링 항상 시도) */
  readonly mirrorHelperPath: string;
  /** Controller HTTP 토큰 — 러너(TEST_RUNNER_...)와 클라이언트 헤더에 함께 배선 */
  readonly controllerToken: string | null;
  /** Android 설정 — adb 미설치 시에만 null (설치돼 있으면 항상 활성) */
  readonly android: AndroidEnvConfig | null;
}

/** Android 환경 설정 (adb 설치돼 있으면 로드, 없으면 null) */
export interface AndroidEnvConfig {
  readonly adbPath: string;
  /** 러너 APK 경로 — 미지정 시 레포 빌드 산출물 기본값 (제어 항상 활성) */
  readonly runnerApkPath: string;
  /** 맥 로컬 포워딩 포트 시작값 (iOS 8200과 분리) */
  readonly basePort: number;
  readonly logDir: string;
  /** 미러링 데몬 dex(apk) 경로 — 미지정 시 레포 빌드 산출물 기본값 (미러링 항상 활성) */
  readonly mirrorDexPath: string;
  /** 미러링 포워딩 포트 시작값 (러너 basePort와 분리 — 기본 8400) */
  readonly mirrorBasePort: number;
  /** 러너 수퍼바이저 타이밍 (전부 env 조정 가능) */
  readonly supervisorTuning: AndroidSupervisorTuning;
  /** 러너(device) 액션 타이밍 — am instrument -e로 기기에 전달 */
  readonly runnerTuning: AndroidRunnerTuning;
  /** 미러링 스트림(agent)·데몬(device) 타이밍 — 데몬 쪽은 app_process 인자로 전달 */
  readonly mirrorTuning: AndroidMirrorTuning;
}

/** Android 러너 수퍼바이저 타이밍 (agent 쪽) */
export interface AndroidSupervisorTuning {
  readonly healthIntervalMs: number;
  readonly healthFailThreshold: number;
  readonly restartBaseMs: number;
  readonly restartMaxMs: number;
  readonly killEscalationMs: number;
  readonly portCooldownMs: number;
  readonly readyDeadlineMs: number;
  readonly reinstallAfterFailures: number;
}

/** Android 러너(device) 액션 타이밍 — am instrument -e 인자로 전달 */
export interface AndroidRunnerTuning {
  readonly actionTimeoutMs: number;
  readonly swipeStepMs: number;
  readonly maxSwipeDurationMs: number;
}

/** Android 미러링 타이밍 — agent 스트림 관리 + device 인코더 데몬 */
export interface AndroidMirrorTuning {
  // agent 쪽 스트림 관리
  readonly restartBaseMs: number;
  readonly restartMaxMs: number;
  readonly errorThreshold: number;
  readonly killEscalationMs: number;
  readonly preambleDeadlineMs: number;
  readonly connectRetryMs: number;
  // device 쪽 인코더 데몬 (app_process 인자로 전달)
  readonly bitRate: number;
  readonly fps: number;
  readonly iframeIntervalSec: number;
  /** 정지 화면 재발행 주기 (ms) — KEY_REPEAT_PREVIOUS_FRAME_AFTER */
  readonly repeatFrameMs: number;
  /** 접힘/펼침 SWAP 감지 폴링 주기 (ms) */
  readonly swapPollMs: number;
  readonly acceptDeadlineMs: number;
}

/** 수퍼바이저 환경 설정 */
export interface SupervisorEnvConfig {
  readonly projectPath: string;
  readonly scheme: string;
  readonly basePort: number;
  readonly derivedDataDir: string;
  readonly logDir: string;
  /** 러너 헬스 폴링 주기 (ms) */
  readonly healthIntervalMs: number;
}

/** 서버 게이트웨이와 동일한 agentId 허용 형식 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_DISCOVERY_INTERVAL_MS = 20_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
/** 주기 하한 — 1ms 같은 값이 devicectl spawn 폭주로 이어지는 것 방지 */
const MIN_INTERVAL_MS = 1_000;
const MIN_TOKEN_LENGTH = 24;

/** 호스트명을 agentId 허용 형식으로 정규화 */
export function sanitizeAgentId(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (sanitized.length === 0) return 'agent';
  return sanitized;
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
      platform: parseStaticPlatform(record.platform),
      osVersion: record.osVersion,
      tags: parseTags(record.tags),
    };
  });
}

/** 정적 기기 platform — 미지정은 'ios' 기본, 알 수 없는 값은 즉시 실패 */
function parseStaticPlatform(raw: unknown): DevicePlatform {
  if (raw === undefined) return 'ios';
  if (isDevicePlatform(raw)) return raw;
  throw new Error(`NEBULA_STATIC_DEVICES platform 값 오류: ${String(raw)} (ios|android)`);
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

  const basePort = parsePositiveInt(
    'NEBULA_CONTROLLER_BASE_PORT',
    env.NEBULA_CONTROLLER_BASE_PORT,
    DEFAULT_SUPERVISOR_BASE_PORT,
  );
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
    healthIntervalMs: parsePositiveInt(
      'NEBULA_CONTROLLER_HEALTH_INTERVAL_MS',
      env.NEBULA_CONTROLLER_HEALTH_INTERVAL_MS,
      DEFAULT_HEALTH_INTERVAL_MS,
      MIN_INTERVAL_MS,
    ),
  };
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name}: 양의 정수가 아닌 값: ${raw}`);
  }
  if (parsed < minimum) {
    // 주기류가 너무 짧으면 devicectl spawn 폭주 — 하한 강제
    throw new Error(`${name}: 최소 ${minimum} 이상이어야 함 (받은 값: ${raw})`);
  }
  return parsed;
}

/**
 * mirror-helper 경로 — 명시 override 우선(오타면 즉시 실패), 미지정 시 레포 빌드 기본값.
 * 기본값은 존재 검증 안 함 — 빌드 전이거나 macOS 버전 제약일 수 있고, 런타임 spawn이 실패를 드러냄
 */
function parseMirrorHelperPath(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_MIRROR_HELPER;
  try {
    accessSync(trimmed, constants.X_OK);
  } catch {
    throw new Error(`NEBULA_MIRROR_HELPER 경로가 없거나 실행 권한 없음: ${trimmed}`);
  }
  return trimmed;
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
  // 서버는 change-me* 값을 거부함 — 여기서 안 걸러주면 4401 재연결 루프로만 드러남
  if (agentToken.startsWith('change-me')) {
    throw new Error('NEBULA_AGENT_TOKEN이 플레이스홀더 값 — openssl rand -hex 32로 교체');
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
      'NEBULA_DISCOVERY_INTERVAL_MS',
      env.NEBULA_DISCOVERY_INTERVAL_MS,
      DEFAULT_DISCOVERY_INTERVAL_MS,
      MIN_INTERVAL_MS,
    ),
    heartbeatIntervalMs: parsePositiveInt(
      'NEBULA_HEARTBEAT_INTERVAL_MS',
      env.NEBULA_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      MIN_INTERVAL_MS,
    ),
    staticDevices: parseStaticDevices(env.NEBULA_STATIC_DEVICES),
    supervisor: parseSupervisorConfig(env),
    mirrorHelperPath: parseMirrorHelperPath(env.NEBULA_MIRROR_HELPER),
    controllerToken: parseControllerToken(env.NEBULA_CONTROLLER_TOKEN),
    android: parseAndroidConfig(env),
  };
}

const DEFAULT_ANDROID_BASE_PORT = 8300;
const DEFAULT_ANDROID_MIRROR_BASE_PORT = 8400;

/**
 * adb 경로 해석 — 명시(NEBULA_ADB_PATH) 우선, 없으면 PATH·표준 위치 탐색.
 * 미설치면 null 반환 → Android 자동 비활성 (설치돼 있으면 항상 활성). 명시 경로 오타만 즉시 실패
 */
function resolveAdbPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.NEBULA_ADB_PATH?.trim();
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      throw new Error(`NEBULA_ADB_PATH가 없거나 실행 권한 없음: ${explicit}`);
    }
  }

  // PATH 우선 — SDK platform-tools든 brew든 사용자 환경을 그대로 존중
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir) candidates.push(join(dir, 'adb'));
  }
  // PATH에 없을 때의 표준 위치 (Apple Silicon·Intel brew, Android SDK 기본)
  candidates.push(
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
  );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** Android 설정 로드 — adb가 있으면 항상 활성 (별도 켜기 플래그 없음), 없으면 null */
export function parseAndroidConfig(env: NodeJS.ProcessEnv): AndroidEnvConfig | null {
  const adbPath = resolveAdbPath(env);
  if (!adbPath) return null;

  const basePort = parsePositiveInt(
    'NEBULA_ANDROID_BASE_PORT',
    env.NEBULA_ANDROID_BASE_PORT,
    DEFAULT_ANDROID_BASE_PORT,
  );
  if (basePort > MAX_BASE_PORT) {
    throw new Error(`NEBULA_ANDROID_BASE_PORT는 ${MAX_BASE_PORT} 이하여야 함`);
  }

  const mirrorBasePort = parsePositiveInt(
    'NEBULA_ANDROID_MIRROR_BASE_PORT',
    env.NEBULA_ANDROID_MIRROR_BASE_PORT,
    DEFAULT_ANDROID_MIRROR_BASE_PORT,
  );
  if (mirrorBasePort > MAX_BASE_PORT) {
    throw new Error(`NEBULA_ANDROID_MIRROR_BASE_PORT는 ${MAX_BASE_PORT} 이하여야 함`);
  }

  return {
    adbPath,
    runnerApkPath: resolveArtifact(
      'NEBULA_ANDROID_RUNNER_APK',
      env.NEBULA_ANDROID_RUNNER_APK,
      DEFAULT_RUNNER_APK,
    ),
    basePort,
    logDir: env.NEBULA_CONTROLLER_LOG_DIR ?? join(homedir(), '.nebula', 'logs'),
    mirrorDexPath: resolveArtifact(
      'NEBULA_ANDROID_MIRROR_DEX',
      env.NEBULA_ANDROID_MIRROR_DEX,
      DEFAULT_MIRROR_DEX,
    ),
    mirrorBasePort,
    supervisorTuning: parseAndroidSupervisorTuning(env),
    runnerTuning: parseAndroidRunnerTuning(env),
    mirrorTuning: parseAndroidMirrorTuning(env),
  };
}

/** env 이름·기본값·최소값 스펙 → 정수 필드 묶음 파싱 (반복 parsePositiveInt 제거) */
function parseIntFields<T>(
  env: NodeJS.ProcessEnv,
  spec: { [K in keyof T]: readonly [name: string, fallback: number, minimum?: number] },
): T {
  const out: Record<string, number> = {};
  for (const key of Object.keys(spec) as (keyof T)[]) {
    const [name, fallback, minimum] = spec[key];
    out[key as string] = parsePositiveInt(name, env[name], fallback, minimum ?? 1);
  }
  return out as T;
}

function parseAndroidSupervisorTuning(env: NodeJS.ProcessEnv): AndroidSupervisorTuning {
  return parseIntFields<AndroidSupervisorTuning>(env, {
    healthIntervalMs: ['NEBULA_ANDROID_HEALTH_INTERVAL_MS', 10_000, MIN_INTERVAL_MS],
    healthFailThreshold: ['NEBULA_ANDROID_HEALTH_FAIL_THRESHOLD', 3],
    restartBaseMs: ['NEBULA_ANDROID_RESTART_BASE_MS', 2_000],
    restartMaxMs: ['NEBULA_ANDROID_RESTART_MAX_MS', 60_000],
    killEscalationMs: ['NEBULA_ANDROID_KILL_ESCALATION_MS', 3_000],
    portCooldownMs: ['NEBULA_ANDROID_PORT_COOLDOWN_MS', 5_000],
    readyDeadlineMs: ['NEBULA_ANDROID_READY_DEADLINE_MS', 60_000],
    reinstallAfterFailures: ['NEBULA_ANDROID_REINSTALL_AFTER_FAILURES', 3],
  });
}

function parseAndroidRunnerTuning(env: NodeJS.ProcessEnv): AndroidRunnerTuning {
  return parseIntFields<AndroidRunnerTuning>(env, {
    actionTimeoutMs: ['NEBULA_ANDROID_ACTION_TIMEOUT_MS', 9_000],
    swipeStepMs: ['NEBULA_ANDROID_SWIPE_STEP_MS', 8],
    maxSwipeDurationMs: ['NEBULA_ANDROID_MAX_SWIPE_DURATION_MS', 8_000],
  });
}

function parseAndroidMirrorTuning(env: NodeJS.ProcessEnv): AndroidMirrorTuning {
  return parseIntFields<AndroidMirrorTuning>(env, {
    restartBaseMs: ['NEBULA_ANDROID_MIRROR_RESTART_BASE_MS', 2_000],
    restartMaxMs: ['NEBULA_ANDROID_MIRROR_RESTART_MAX_MS', 60_000],
    errorThreshold: ['NEBULA_ANDROID_MIRROR_ERROR_THRESHOLD', 5],
    killEscalationMs: ['NEBULA_ANDROID_MIRROR_KILL_ESCALATION_MS', 2_000],
    preambleDeadlineMs: ['NEBULA_ANDROID_MIRROR_PREAMBLE_DEADLINE_MS', 10_000],
    connectRetryMs: ['NEBULA_ANDROID_MIRROR_CONNECT_RETRY_MS', 500],
    bitRate: ['NEBULA_ANDROID_MIRROR_BITRATE', 8_000_000],
    fps: ['NEBULA_ANDROID_MIRROR_FPS', 60],
    iframeIntervalSec: ['NEBULA_ANDROID_MIRROR_IFRAME_SEC', 1],
    repeatFrameMs: ['NEBULA_ANDROID_MIRROR_REPEAT_FRAME_MS', 100],
    swapPollMs: ['NEBULA_ANDROID_MIRROR_SWAP_POLL_MS', 500],
    acceptDeadlineMs: ['NEBULA_ANDROID_MIRROR_ACCEPT_DEADLINE_MS', 30_000],
  });
}

/**
 * 산출물 경로 해석 — 명시 override 우선(오타면 즉시 실패), 미지정 시 레포 빌드 기본값.
 * 기본값은 존재 검증 안 함 — 아직 빌드 전일 수 있고, 런타임(adb push/install)이 실패를 시끄럽게 드러냄
 */
function resolveArtifact(name: string, raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    accessSync(trimmed, constants.R_OK);
  } catch {
    throw new Error(`${name} 경로 없음: ${trimmed} — scripts/build-android.sh로 빌드`);
  }
  return trimmed;
}

/** Controller 토큰 — 빈 값은 미설정 취급, 설정 시 서버 토큰과 같은 최소 길이 강제 */
function parseControllerToken(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new Error(`NEBULA_CONTROLLER_TOKEN은 ${MIN_TOKEN_LENGTH}자 이상이어야 함`);
  }
  return trimmed;
}
