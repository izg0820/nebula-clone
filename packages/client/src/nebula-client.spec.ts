import { ApiError } from './api-error';
import { HttpRequestInit, HttpResponseLike } from './http-client';
import { NebulaClient } from './nebula-client';

interface RecordedCall {
  readonly url: string;
  readonly init: HttpRequestInit;
}

/** fetch 주입 fake — 전역 몽키패치 없음 */
function createFake(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
    calls.push({ url, init });
    const spec = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(spec.body ?? {}),
      json: async () => spec.body ?? {},
    };
  };
  return { calls, fetchImpl };
}

function createClient(fake: ReturnType<typeof createFake>): NebulaClient {
  return new NebulaClient({
    baseUrl: 'http://localhost:3999',
    token: 'secret-token',
    fetchImpl: fake.fetchImpl,
  });
}

const TARGET = { deviceId: 'udid-1', occupantId: 'occ-1' };

describe('NebulaClient', () => {
  test('Bearer 헤더 부착 + GET에는 content-type 미부착', async () => {
    const fake = createFake([{ body: [] }]);
    await createClient(fake).listDevices();

    const { init } = fake.calls[0];
    expect(init.headers.authorization).toBe('Bearer secret-token');
    expect(init.headers['content-type']).toBeUndefined();
  });

  test('본문 있는 요청에만 content-type 부착', async () => {
    const fake = createFake([{ body: { occupantId: 'o', device: {}, expiresAt: null } }]);
    await createClient(fake).occupy({ deviceId: 'udid-1' });

    const { init } = fake.calls[0];
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body ?? '')).toEqual({ deviceId: 'udid-1' });
  });

  test('deviceId 특수문자는 URL 인코딩', async () => {
    const fake = createFake([{ body: {} }]);
    await createClient(fake).getDevice('udid/한글 id');

    expect(fake.calls[0].url).toBe(
      'http://localhost:3999/devices/udid%2F%ED%95%9C%EA%B8%80%20id',
    );
  });

  test('비 2xx는 ApiError(status 보존, 본문 200자 절단)', async () => {
    const fake = createFake([{ status: 403, body: { message: 'x'.repeat(500) } }]);

    const promise = createClient(fake).release('udid-1', 'wrong');
    await expect(promise).rejects.toThrow(ApiError);
    await expect(
      createClient(fake).release('udid-1', 'wrong'),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('screenshot·uiDump는 result를 언랩', async () => {
    const screenshotBody = {
      result: { ok: true, jpegBase64: 'abc=', widthPt: 430, heightPt: 932 },
    };
    const fake = createFake([{ body: screenshotBody }]);
    const shot = await createClient(fake).screenshot(TARGET);
    expect(shot.jpegBase64).toBe('abc=');

    const treeFake = createFake([{ body: { result: { ok: true, tree: 'Application' } } }]);
    const tree = await createClient(treeFake).uiDump(TARGET);
    expect(tree).toBe('Application');
  });

  test('조작 API는 occupantId를 본문에 합침 + 액션 경로', async () => {
    const fake = createFake([{ body: { result: { ok: true } } }]);
    await createClient(fake).tap(TARGET, { x: 10, y: 20 });

    expect(fake.calls[0].url).toBe('http://localhost:3999/devices/udid-1/actions/tap');
    expect(JSON.parse(fake.calls[0].init.body ?? '')).toEqual({
      occupantId: 'occ-1',
      x: 10,
      y: 20,
    });
  });

  test('swipe는 durationMs 기본값 300 적용', async () => {
    const fake = createFake([{ body: { result: { ok: true } } }]);
    await createClient(fake).swipe(TARGET, { fromX: 0, fromY: 0, toX: 10, toY: 10 });

    expect(JSON.parse(fake.calls[0].init.body ?? '')).toMatchObject({ durationMs: 300 });
  });

  test('keepalive 경로·본문', async () => {
    const fake = createFake([{ body: { device: {}, expiresAt: null } }]);
    await createClient(fake).keepalive('udid-1', 'occ-1');

    expect(fake.calls[0].url).toBe('http://localhost:3999/devices/udid-1/keepalive');
    expect(JSON.parse(fake.calls[0].init.body ?? '')).toEqual({ occupantId: 'occ-1' });
  });

  test('타임아웃 signal이 요청에 전달됨', async () => {
    const fake = createFake([{ body: {} }]);
    await createClient(fake).health();

    expect(fake.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test('전송 예외(AbortError 등)는 래핑 없이 전파', async () => {
    const fetchImpl = async (): Promise<HttpResponseLike> => {
      throw new DOMException('aborted', 'AbortError');
    };
    const client = new NebulaClient({
      baseUrl: 'http://localhost:3999',
      token: 't',
      fetchImpl,
    });

    await expect(client.health()).rejects.toThrow('aborted');
  });
});
