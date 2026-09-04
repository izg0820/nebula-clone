import { loadConfig, sanitizeAgentId } from './config';

describe('loadConfig', () => {
  const VALID_ENV = {
    NEBULA_SERVER_URL: 'ws://localhost:3000/agent',
    NEBULA_AGENT_TOKEN: 'a'.repeat(24),
    NEBULA_AGENT_ID: 'mac-mini-1',
  };

  test('유효한 환경 변수면 설정 반환 (기본 주기 포함)', () => {
    const config = loadConfig(VALID_ENV);

    expect(config).toMatchObject({
      serverUrl: 'ws://localhost:3000/agent',
      agentId: 'mac-mini-1',
    });
    expect(config.discoveryIntervalMs).toBeGreaterThan(0);
    expect(config.heartbeatIntervalMs).toBeGreaterThan(0);
  });

  test('서버 URL 누락·형식 오류면 실패', () => {
    expect(() => loadConfig({ ...VALID_ENV, NEBULA_SERVER_URL: undefined })).toThrow(
      /NEBULA_SERVER_URL/,
    );
    expect(() => loadConfig({ ...VALID_ENV, NEBULA_SERVER_URL: 'http://x' })).toThrow(
      /NEBULA_SERVER_URL/,
    );
  });

  test('토큰 누락·짧으면 실패', () => {
    expect(() => loadConfig({ ...VALID_ENV, NEBULA_AGENT_TOKEN: undefined })).toThrow(
      /NEBULA_AGENT_TOKEN/,
    );
    expect(() => loadConfig({ ...VALID_ENV, NEBULA_AGENT_TOKEN: 'short' })).toThrow(
      /NEBULA_AGENT_TOKEN/,
    );
  });

  test('agentId 미지정 시 호스트명 기반 자동 생성', () => {
    const config = loadConfig({ ...VALID_ENV, NEBULA_AGENT_ID: undefined });
    expect(config.agentId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  test('주기 값이 양의 정수가 아니면 실패', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, NEBULA_DISCOVERY_INTERVAL_MS: '-1' }),
    ).toThrow(/양의 정수/);
  });
});

describe('sanitizeAgentId', () => {
  test('허용 밖 문자를 하이픈으로 치환하고 64자로 절단', () => {
    expect(sanitizeAgentId('Austin의.MacBook Pro')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sanitizeAgentId('a'.repeat(100))).toHaveLength(64);
    expect(sanitizeAgentId('')).toBe('agent');
  });
});
