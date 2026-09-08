import { MIN_TOKEN_LENGTH, validateEnv } from './env.validation';

describe('validateEnv', () => {
  const STRONG = 'a'.repeat(MIN_TOKEN_LENGTH);
  const STRONG_OTHER = 'b'.repeat(MIN_TOKEN_LENGTH);

  test('충분한 길이의 서로 다른 토큰이면 통과', () => {
    const config = { NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG_OTHER };
    expect(validateEnv(config)).toBe(config);
  });

  test('두 토큰이 같은 값이면 실패 — 클라이언트 토큰으로 Agent 터널 접속 가능해짐', () => {
    expect(() =>
      validateEnv({ NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG }),
    ).toThrow(/서로 다른 값/);
  });

  test('토큰 누락·빈 문자열이면 즉시 실패', () => {
    expect(() => validateEnv({})).toThrow(/NEBULA_CLIENT_TOKEN.*NEBULA_AGENT_TOKEN/);
    expect(() =>
      validateEnv({ NEBULA_CLIENT_TOKEN: '  ', NEBULA_AGENT_TOKEN: STRONG }),
    ).toThrow(/NEBULA_CLIENT_TOKEN/);
  });

  test('플레이스홀더(change-me*) 값이면 실패', () => {
    expect(() =>
      validateEnv({
        NEBULA_CLIENT_TOKEN: 'change-me-please-change-me-now',
        NEBULA_AGENT_TOKEN: STRONG,
      }),
    ).toThrow(/플레이스홀더/);
  });

  test('최소 길이 미만이면 실패', () => {
    expect(() =>
      validateEnv({ NEBULA_CLIENT_TOKEN: 'short-token', NEBULA_AGENT_TOKEN: STRONG }),
    ).toThrow(new RegExp(`${MIN_TOKEN_LENGTH}자 미만`));
  });

  test('NEBULA_OCCUPATION_TTL_MS 미설정이면 통과 (기본값 사용)', () => {
    const config = { NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG_OTHER };
    expect(validateEnv(config)).toBe(config);
  });

  test('NEBULA_OCCUPATION_TTL_MS 정상값이면 통과', () => {
    const config = {
      NEBULA_CLIENT_TOKEN: STRONG,
      NEBULA_AGENT_TOKEN: STRONG_OTHER,
      NEBULA_OCCUPATION_TTL_MS: '600000',
    };
    expect(validateEnv(config)).toBe(config);
  });

  test('NEBULA_OCCUPATION_TTL_MS 비정수·하한 미만이면 실패', () => {
    const base = { NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG_OTHER };
    expect(() => validateEnv({ ...base, NEBULA_OCCUPATION_TTL_MS: 'abc' })).toThrow(
      /NEBULA_OCCUPATION_TTL_MS.*정수/,
    );
    expect(() => validateEnv({ ...base, NEBULA_OCCUPATION_TTL_MS: '1000' })).toThrow(
      /NEBULA_OCCUPATION_TTL_MS/,
    );
  });

  test('NEBULA_RATE_LIMIT_PER_MINUTE — 정상·미설정 통과, 비정수·0 이하 실패', () => {
    const base = { NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG_OTHER };
    expect(validateEnv({ ...base, NEBULA_RATE_LIMIT_PER_MINUTE: '10000' })).toBeTruthy();
    expect(() => validateEnv({ ...base, NEBULA_RATE_LIMIT_PER_MINUTE: 'abc' })).toThrow(
      /NEBULA_RATE_LIMIT_PER_MINUTE/,
    );
    expect(() => validateEnv({ ...base, NEBULA_RATE_LIMIT_PER_MINUTE: '0' })).toThrow(
      /NEBULA_RATE_LIMIT_PER_MINUTE/,
    );
  });
});
