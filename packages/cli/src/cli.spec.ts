import { ApiError, PublicDevice } from '@nebula/client';
import { run, CliDeps } from './cli';
import { FarmClient } from './commands';
import { EXIT_AUTH, EXIT_GATEWAY, EXIT_NOT_FOUND, EXIT_USAGE, statusToExitCode } from './exit-codes';
import { MemorySessionStore, StoredOccupation } from './session-store';

const DEVICE: PublicDevice = {
  id: 'udid-1',
  name: 'iPhone 14 Pro Max',
  platform: 'ios',
  osVersion: '26.0',
  tags: ['controller-ready'],
  status: 'online',
  agentId: 'agent-1',
  occupiedAt: null,
  lastHeartbeatAt: null,
  lastActivityAt: null,
  isOccupied: false,
};

const SERVER_URL = 'http://localhost:3000';

function createFakeClient(overrides: Partial<Record<keyof FarmClient, jest.Mock>> = {}) {
  const client = {
    health: jest.fn().mockResolvedValue({ status: 'ok' }),
    listDevices: jest.fn().mockResolvedValue([DEVICE]),
    getDevice: jest.fn().mockResolvedValue(DEVICE),
    occupy: jest.fn().mockResolvedValue({
      occupantId: 'occ-new',
      device: DEVICE,
      expiresAt: '2026-09-08T01:00:00.000Z',
    }),
    release: jest.fn().mockResolvedValue(DEVICE),
    keepalive: jest.fn().mockResolvedValue({ device: DEVICE, expiresAt: null }),
    tap: jest.fn().mockResolvedValue(undefined),
    swipe: jest.fn().mockResolvedValue(undefined),
    typeText: jest.fn().mockResolvedValue(undefined),
    pressButton: jest.fn().mockResolvedValue(undefined),
    uiDump: jest.fn().mockResolvedValue('Application tree'),
    screenshot: jest.fn().mockResolvedValue({
      ok: true,
      jpegBase64: Buffer.from('jpeg-bytes').toString('base64'),
      widthPt: 430,
      heightPt: 932,
    }),
    ...overrides,
  };
  return client as FarmClient & Record<keyof FarmClient, jest.Mock>;
}

interface Fixture {
  readonly deps: CliDeps;
  readonly client: ReturnType<typeof createFakeClient>;
  readonly session: MemorySessionStore;
  readonly out: string[];
  readonly err: string[];
  readonly saved: Array<{ path: string; data: Uint8Array }>;
}

function createFixture(options: {
  client?: ReturnType<typeof createFakeClient>;
  env?: Record<string, string | undefined>;
  session?: StoredOccupation;
} = {}): Fixture {
  const client = options.client ?? createFakeClient();
  const session = new MemorySessionStore();
  if (options.session) session.save(options.session);
  const out: string[] = [];
  const err: string[] = [];
  const saved: Array<{ path: string; data: Uint8Array }> = [];
  const deps: CliDeps = {
    env: { NEBULA_CLIENT_TOKEN: 'token-from-env', ...options.env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    createClient: () => client,
    session,
    saveFile: (path, data) => saved.push({ path, data }),
  };
  return { deps, client, session, out, err, saved };
}

const STORED: StoredOccupation = {
  serverUrl: SERVER_URL,
  deviceId: 'udid-1',
  occupantId: 'occ-stored',
  occupiedAt: '2026-09-08T00:00:00.000Z',
};

describe('run', () => {
  test('devices list — 기본은 사람용 요약, --json은 원문', async () => {
    const fixture = createFixture();
    await run(['devices', 'list'], fixture.deps);
    expect(fixture.out[0]).toContain('udid-1');
    expect(fixture.out[0]).toContain('iPhone 14 Pro Max');

    const jsonFixture = createFixture();
    await run(['devices', 'list', '--json'], jsonFixture.deps);
    expect(JSON.parse(jsonFixture.out[0])).toEqual([DEVICE]);
  });

  test('알 수 없는 커맨드·그룹은 사용법 오류(2)', async () => {
    const fixture = createFixture();
    expect(await run(['unknown'], fixture.deps)).toBe(EXIT_USAGE);
    expect(fixture.err[0]).toContain('알 수 없는 커맨드');
    expect(await run(['devices', 'unknown'], createFixture().deps)).toBe(EXIT_USAGE);
  });

  test('--help는 0, 커맨드 없음은 2 (둘 다 사용법 출력)', async () => {
    const help = createFixture();
    expect(await run(['--help'], help.deps)).toBe(0);
    expect(help.out[0]).toContain('nebula');

    expect(await run([], createFixture().deps)).toBe(EXIT_USAGE);
  });

  test('tap 필수 플래그 누락은 2 + API 미호출, 비정수 값도 2', async () => {
    const fixture = createFixture({ session: STORED });
    expect(await run(['tap', '--y', '10'], fixture.deps)).toBe(EXIT_USAGE);
    expect(fixture.client.tap).not.toHaveBeenCalled();

    expect(await run(['tap', '--x', 'abc', '--y', '10'], createFixture().deps)).toBe(EXIT_USAGE);
  });

  test('--tags "a, b" → [a, b]로 파싱되어 occupy에 전달', async () => {
    const fixture = createFixture();
    await run(['devices', 'occupy', '--tags', 'a, b'], fixture.deps);
    expect(fixture.client.occupy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['a', 'b'] }),
    );
  });

  test('occupantId 우선순위 — 플래그 > env > 세션, 셋 다 없으면 2', async () => {
    const flagged = createFixture({ session: STORED, env: { NEBULA_OCCUPANT_ID: 'occ-env' } });
    await run(['tap', '--x', '1', '--y', '2', '--occupant-id', 'occ-flag'], flagged.deps);
    expect(flagged.client.tap).toHaveBeenCalledWith(
      { deviceId: 'udid-1', occupantId: 'occ-flag' },
      { x: 1, y: 2 },
    );

    const fromEnv = createFixture({ session: STORED, env: { NEBULA_OCCUPANT_ID: 'occ-env' } });
    await run(['tap', '--x', '1', '--y', '2'], fromEnv.deps);
    expect(fromEnv.client.tap).toHaveBeenCalledWith(
      expect.objectContaining({ occupantId: 'occ-env' }),
      expect.anything(),
    );

    const fromSession = createFixture({ session: STORED });
    await run(['tap', '--x', '1', '--y', '2'], fromSession.deps);
    expect(fromSession.client.tap).toHaveBeenCalledWith(
      expect.objectContaining({ occupantId: 'occ-stored' }),
      expect.anything(),
    );

    const none = createFixture();
    expect(await run(['tap', '--x', '1', '--y', '2', '--device-id', 'udid-1'], none.deps)).toBe(
      EXIT_USAGE,
    );
  });

  test('다른 서버의 세션은 무시 (occupantId 오용 방지)', async () => {
    const fixture = createFixture({
      session: { ...STORED, serverUrl: 'http://other:3000' },
    });
    expect(await run(['tap', '--x', '1', '--y', '2'], fixture.deps)).toBe(EXIT_USAGE);
  });

  test('occupy 성공 시 세션 저장, release 성공 시 삭제', async () => {
    const fixture = createFixture();
    await run(['devices', 'occupy'], fixture.deps);
    expect(fixture.session.load()).toMatchObject({
      deviceId: 'udid-1',
      occupantId: 'occ-new',
      serverUrl: SERVER_URL,
    });

    await run(['devices', 'release'], fixture.deps);
    expect(fixture.session.load()).toBeNull();
  });

  test('403 응답은 코드 3 + 세션 자동 정리', async () => {
    const client = createFakeClient({
      tap: jest.fn().mockRejectedValue(new ApiError(403, 'POST /devices/udid-1/actions/tap → 403')),
    });
    const fixture = createFixture({ client, session: STORED });

    expect(await run(['tap', '--x', '1', '--y', '2'], fixture.deps)).toBe(EXIT_AUTH);
    expect(fixture.session.load()).toBeNull();
    expect(fixture.err.some((line) => line.includes('다시 점유'))).toBe(true);
  });

  test('keepalive/release의 409(만료 회수 후 미점유)도 세션 정리', async () => {
    const keepalive409 = createFixture({
      client: createFakeClient({
        keepalive: jest.fn().mockRejectedValue(new ApiError(409, 'not occupied')),
      }),
      session: STORED,
    });
    expect(await run(['devices', 'keepalive'], keepalive409.deps)).toBe(EXIT_NOT_FOUND);
    expect(keepalive409.session.load()).toBeNull();

    const release409 = createFixture({
      client: createFakeClient({
        release: jest.fn().mockRejectedValue(new ApiError(409, 'not occupied')),
      }),
      session: STORED,
    });
    await run(['devices', 'release'], release409.deps);
    expect(release409.session.load()).toBeNull();
  });

  test('액션의 409(기기 오프라인)는 세션 유지 — 점유 무효가 아님', async () => {
    const fixture = createFixture({
      client: createFakeClient({
        tap: jest.fn().mockRejectedValue(new ApiError(409, '기기 오프라인')),
      }),
      session: STORED,
    });

    expect(await run(['tap', '--x', '1', '--y', '2'], fixture.deps)).toBe(EXIT_NOT_FOUND);
    expect(fixture.session.load()).toEqual(STORED);
  });

  test('명시 플래그로 다른 대상을 겨눈 403은 저장 세션을 지우지 않음', async () => {
    const otherDevice = createFixture({
      client: createFakeClient({
        tap: jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')),
      }),
      session: STORED,
    });
    await run(
      ['tap', '--x', '1', '--y', '2', '--device-id', 'other-udid', '--occupant-id', 'occ-x'],
      otherDevice.deps,
    );
    expect(otherDevice.session.load()).toEqual(STORED);

    const otherOccupant = createFixture({
      client: createFakeClient({
        release: jest.fn().mockRejectedValue(new ApiError(403, 'forbidden')),
      }),
      session: STORED,
    });
    await run(['devices', 'release', '--occupant-id', 'someone-else'], otherOccupant.deps);
    expect(otherOccupant.session.load()).toEqual(STORED);
  });

  test('status→종료 코드 매핑 전수', () => {
    expect(statusToExitCode(401)).toBe(EXIT_AUTH);
    expect(statusToExitCode(403)).toBe(EXIT_AUTH);
    expect(statusToExitCode(429)).toBe(EXIT_AUTH);
    expect(statusToExitCode(404)).toBe(EXIT_NOT_FOUND);
    expect(statusToExitCode(409)).toBe(EXIT_NOT_FOUND);
    expect(statusToExitCode(502)).toBe(EXIT_GATEWAY);
    expect(statusToExitCode(504)).toBe(EXIT_GATEWAY);
    expect(statusToExitCode(500)).toBe(1);
  });

  test('screenshot --out은 base64 디코드 저장, 미지정+비JSON은 2', async () => {
    const fixture = createFixture({ session: STORED });
    await run(['screenshot', '--out', 'shot.jpg'], fixture.deps);
    expect(fixture.saved[0].path).toBe('shot.jpg');
    expect(Buffer.from(fixture.saved[0].data).toString()).toBe('jpeg-bytes');

    const bare = createFixture({ session: STORED });
    expect(await run(['screenshot'], bare.deps)).toBe(EXIT_USAGE);
  });

  test('토큰 없으면 2 (health는 예외)', async () => {
    const noToken = createFixture({ env: { NEBULA_CLIENT_TOKEN: undefined } });
    expect(await run(['devices', 'list'], noToken.deps)).toBe(EXIT_USAGE);

    const health = createFixture({ env: { NEBULA_CLIENT_TOKEN: undefined } });
    expect(await run(['health'], health.deps)).toBe(0);
    expect(health.out[0]).toBe('ok');
  });

  test('keepalive는 세션 대상에 대해 호출', async () => {
    const fixture = createFixture({ session: STORED });
    await run(['devices', 'keepalive'], fixture.deps);
    expect(fixture.client.keepalive).toHaveBeenCalledWith('udid-1', 'occ-stored');
  });

  test('devices session --clear는 세션 삭제', async () => {
    const fixture = createFixture({ session: STORED });
    await run(['devices', 'session', '--clear'], fixture.deps);
    expect(fixture.session.load()).toBeNull();
  });
});
