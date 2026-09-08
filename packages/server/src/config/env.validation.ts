import { MIN_OCCUPATION_TTL_MS } from './constants';

/** 기동 시 필수 환경 변수 검증 — 누락·약한 토큰이면 즉시 실패 */
const REQUIRED_TOKEN_KEYS = ['NEBULA_CLIENT_TOKEN', 'NEBULA_AGENT_TOKEN'] as const;

/** 토큰 최소 길이 — 공인 IP 노출 전제라 무차별 대입 여유를 두지 않음 */
export const MIN_TOKEN_LENGTH = 24;

/** 배포 시 교체하지 않은 플레이스홀더 감지용 접두사 */
const PLACEHOLDER_PREFIX = 'change-me';

/** 토큰 값 검증 실패 사유 (유효하면 null) */
function tokenProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return '누락';
  if (value.startsWith(PLACEHOLDER_PREFIX)) return '플레이스홀더 값 그대로 사용';
  if (value.length < MIN_TOKEN_LENGTH) return `${MIN_TOKEN_LENGTH}자 미만`;
  return null;
}

/** 선택적 점유 TTL 오버라이드 검증 실패 사유 — 미설정이면 기본값 사용이라 통과 */
function occupationTtlProblem(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return '정수 ms 값이어야 함';
  if (parsed < MIN_OCCUPATION_TTL_MS) return `${MIN_OCCUPATION_TTL_MS}ms 미만 불가`;
  return null;
}

/** 선택적 rate limit 오버라이드 — 미설정이면 기본값(RATE_LIMIT_PER_MINUTE) */
function rateLimitProblem(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return '1 이상 정수여야 함';
  return null;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const problems = REQUIRED_TOKEN_KEYS.map((key) => {
    const problem = tokenProblem(config[key]);
    return problem ? `${key}: ${problem}` : null;
  }).filter((problem): problem is string => problem !== null);

  const ttlProblem = occupationTtlProblem(config.NEBULA_OCCUPATION_TTL_MS);
  if (ttlProblem) problems.push(`NEBULA_OCCUPATION_TTL_MS: ${ttlProblem}`);

  const limitProblem = rateLimitProblem(config.NEBULA_RATE_LIMIT_PER_MINUTE);
  if (limitProblem) problems.push(`NEBULA_RATE_LIMIT_PER_MINUTE: ${limitProblem}`);

  // 두 토큰이 같으면 클라이언트(읽기) 토큰으로 Agent 터널 접속이 가능해짐 — 권한 분리 붕괴
  if (
    problems.length === 0 &&
    config.NEBULA_CLIENT_TOKEN === config.NEBULA_AGENT_TOKEN
  ) {
    problems.push('NEBULA_CLIENT_TOKEN과 NEBULA_AGENT_TOKEN은 서로 다른 값이어야 함');
  }

  if (problems.length > 0) {
    throw new Error(
      `환경 변수 검증 실패 — ${problems.join(' / ')} ` +
        `(생성 예: openssl rand -hex 32, .env.example 참고)`,
    );
  }
  return config;
}
