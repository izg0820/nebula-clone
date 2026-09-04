import { MIN_TOKEN_LENGTH, validateEnv } from './env.validation';

describe('validateEnv', () => {
  const STRONG = 'a'.repeat(MIN_TOKEN_LENGTH);

  test('충분한 길이의 토큰이면 통과', () => {
    const config = { NEBULA_CLIENT_TOKEN: STRONG, NEBULA_AGENT_TOKEN: STRONG };
    expect(validateEnv(config)).toBe(config);
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
});
