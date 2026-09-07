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
});
