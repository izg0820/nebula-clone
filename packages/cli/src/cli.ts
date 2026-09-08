import { ApiError, toErrorMessage } from '@nebula/client';
import { CliFlags, parseCliArgs } from './args';
import { COMMANDS, CommandContext, FarmClient } from './commands';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, statusToExitCode, UsageError } from './exit-codes';
import { SessionStore } from './session-store';
import { USAGE } from './usage';

const DEFAULT_SERVER_URL = 'http://localhost:3000';

/** 409가 "점유 없음"을 뜻하는 명령 — keepalive/release의 409는 not_occupied뿐.
 * 다른 명령의 409(occupy 가용 없음, 액션 기기 오프라인)에서 세션을 지우면 안 됨 */
const SESSION_INVALID_ON_409 = new Set(['devices keepalive', 'devices release']);

export interface CliDeps {
  readonly env: Record<string, string | undefined>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly createClient: (options: {
    baseUrl: string;
    token: string;
    timeoutMs?: number;
  }) => FarmClient;
  readonly session: SessionStore;
  readonly saveFile: (path: string, data: Uint8Array) => void;
}

/** 커맨드 키 해석 — devices 그룹은 두 positional을 합침 */
function toCommandKey(positionals: readonly string[]): string {
  if (positionals[0] === 'devices') return `devices ${positionals[1] ?? ''}`.trim();
  return positionals[0] ?? '';
}

/**
 * 점유 무효 응답 시 저장 세션 정리 — 단, 이번 명령이 실제로 저장 세션을 겨눴을 때만.
 * 명시 플래그(--device-id/--occupant-id)로 다른 대상을 지정한 실패가 유효한 세션을
 * 지우면 안 되고, 반대로 keepalive/release의 409(not_occupied)는 세션 무효가 맞음
 */
function cleanupInvalidSession(
  deps: CliDeps,
  serverUrl: string,
  commandKey: string,
  flags: CliFlags | null,
  status: number,
): void {
  const stored = deps.session.load();
  if (!stored || stored.serverUrl !== serverUrl) return;
  if (flags?.deviceId && flags.deviceId !== stored.deviceId) return;
  if (flags?.occupantId && flags.occupantId !== stored.occupantId) return;

  const isInvalid = status === 403 || (status === 409 && SESSION_INVALID_ON_409.has(commandKey));
  if (!isInvalid) return;
  deps.session.clear();
  deps.stderr('저장된 점유 세션이 무효라 정리했습니다 — devices occupy로 다시 점유하세요');
}

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  let serverUrl = DEFAULT_SERVER_URL;
  let commandKey = '';
  let parsedFlags: CliFlags | null = null;
  try {
    const { positionals, flags } = parseCliArgs(argv);
    parsedFlags = flags;
    if (flags.help || positionals.length === 0) {
      deps.stdout(USAGE);
      if (flags.help) return EXIT_OK;
      return EXIT_USAGE;
    }

    commandKey = toCommandKey(positionals);
    const handler = COMMANDS[commandKey];
    if (!handler) throw new UsageError(`알 수 없는 커맨드: ${commandKey}`);

    serverUrl = flags.server ?? deps.env.NEBULA_SERVER_URL ?? DEFAULT_SERVER_URL;
    const token = flags.token ?? deps.env.NEBULA_CLIENT_TOKEN;
    // health는 서버가 @Public — 토큰 없이도 허용
    if (!token && commandKey !== 'health') {
      throw new UsageError('토큰 없음 — NEBULA_CLIENT_TOKEN 환경 변수(권장) 또는 --token 지정');
    }

    const context: CommandContext = {
      client: deps.createClient({ baseUrl: serverUrl, token: token ?? '', timeoutMs: flags.timeoutMs }),
      flags,
      serverUrl,
      env: deps.env,
      session: deps.session,
      stdout: deps.stdout,
      saveFile: deps.saveFile,
    };
    return await handler(context);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`nebula: ${error.message}`);
      deps.stderr('사용법은 nebula --help');
      return EXIT_USAGE;
    }
    if (error instanceof ApiError) {
      deps.stderr(`nebula: ${error.message}`);
      cleanupInvalidSession(deps, serverUrl, commandKey, parsedFlags, error.status);
      return statusToExitCode(error.status);
    }
    deps.stderr(`nebula: ${toErrorMessage(error)}`);
    return EXIT_FAILURE;
  }
}
