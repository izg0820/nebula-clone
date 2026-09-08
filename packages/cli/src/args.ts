import { parseArgs } from 'util';
import { UsageError } from './exit-codes';

/** 파싱된 전역·커맨드 플래그 — 숫자·목록은 여기서 이미 검증·변환됨 */
export interface CliFlags {
  readonly server?: string;
  readonly token?: string;
  readonly deviceId?: string;
  readonly occupantId?: string;
  readonly json: boolean;
  readonly help: boolean;
  readonly clear: boolean;
  readonly timeoutMs?: number;
  readonly out?: string;
  readonly x?: number;
  readonly y?: number;
  readonly fromX?: number;
  readonly fromY?: number;
  readonly toX?: number;
  readonly toY?: number;
  readonly durationMs?: number;
  readonly text?: string;
  readonly button?: string;
  readonly platform?: string;
  readonly tags?: readonly string[];
}

export interface ParsedCli {
  readonly positionals: readonly string[];
  readonly flags: CliFlags;
}

const OPTION_SPEC = {
  server: { type: 'string' },
  token: { type: 'string' },
  'device-id': { type: 'string' },
  'occupant-id': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
  clear: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  out: { type: 'string' },
  x: { type: 'string' },
  y: { type: 'string' },
  'from-x': { type: 'string' },
  'from-y': { type: 'string' },
  'to-x': { type: 'string' },
  'to-y': { type: 'string' },
  'duration-ms': { type: 'string' },
  text: { type: 'string' },
  button: { type: 'string' },
  platform: { type: 'string' },
  tags: { type: 'string' },
} as const;

/** parseArgs는 숫자도 문자열로 줌 — 정수 검증 포함 변환 */
function toInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new UsageError(`--${name} 값은 정수여야 함: ${raw}`);
  return parsed;
}

function toTags(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) throw new UsageError('--tags 값이 비어 있음 (예: --tags smoke,e2e)');
  return tags;
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTION_SPEC,
      allowPositionals: true,
      strict: true,
    });
    return {
      positionals,
      flags: {
        server: values.server,
        token: values.token,
        deviceId: values['device-id'],
        occupantId: values['occupant-id'],
        json: values.json ?? false,
        help: values.help ?? false,
        clear: values.clear ?? false,
        timeoutMs: toInteger(values['timeout-ms'], 'timeout-ms'),
        out: values.out,
        x: toInteger(values.x, 'x'),
        y: toInteger(values.y, 'y'),
        fromX: toInteger(values['from-x'], 'from-x'),
        fromY: toInteger(values['from-y'], 'from-y'),
        toX: toInteger(values['to-x'], 'to-x'),
        toY: toInteger(values['to-y'], 'to-y'),
        durationMs: toInteger(values['duration-ms'], 'duration-ms'),
        text: values.text,
        button: values.button,
        platform: values.platform,
        tags: toTags(values.tags),
      },
    };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // parseArgs의 알 수 없는 플래그·값 누락 오류를 사용법 오류로 변환
    throw new UsageError((error as Error).message);
  }
}
