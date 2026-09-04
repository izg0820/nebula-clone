import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mergeWithStatic } from './device-discovery';
import { ControllerClient } from './controller-client';

describe('ControllerClient (실제 HTTP 서버 연동)', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { path: string; body: unknown } | null;

  beforeEach((done) => {
    lastRequest = null;
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      request.on('end', () => {
        lastRequest = { path: request.url ?? '', body: raw.length > 0 ? JSON.parse(raw) : null };
        if (request.url === '/fail') {
          response.writeHead(500).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterEach((done) => {
    server.close(() => done());
  });

  test('tap 액션을 /tap POST로 변환', async () => {
    const client = new ControllerClient(baseUrl);

    const outcome = await client.execute({ kind: 'tap', x: 10, y: 20 });

    expect(outcome).toEqual({ ok: true, result: { ok: true } });
    expect(lastRequest).toEqual({ path: '/tap', body: { x: 10, y: 20 } });
  });

  test('typeText·uiDump 경로 매핑', async () => {
    const client = new ControllerClient(baseUrl);

    await client.execute({ kind: 'typeText', text: '안녕' });
    expect(lastRequest?.path).toBe('/type');

    await client.execute({ kind: 'uiDump' });
    expect(lastRequest?.path).toBe('/ui');
  });

  test('연결 불가·비2xx는 실패 outcome (throw 금지)', async () => {
    const unreachable = new ControllerClient('http://127.0.0.1:1');
    expect((await unreachable.execute({ kind: 'uiDump' })).ok).toBe(false);
  });
});

describe('mergeWithStatic', () => {
  const STATIC = [{ id: 's1', name: 'Fake', platform: 'ios' as const, osVersion: '17', tags: [] }];
  const REAL = [{ id: 'r1', name: 'iPhone', platform: 'ios' as const, osVersion: '17', tags: [] }];

  test('정적 기기 없으면 발견 결과 그대로 (실패 null 유지)', () => {
    expect(mergeWithStatic(null, [])).toBeNull();
    expect(mergeWithStatic(REAL, [])).toBe(REAL);
  });

  test('정적 기기 있으면 발견 실패도 성공으로 취급', () => {
    expect(mergeWithStatic(null, STATIC)).toEqual(STATIC);
  });

  test('병합 시 정적 기기가 동일 id를 우선', () => {
    const conflicting = [{ ...REAL[0], id: 's1' }];
    expect(mergeWithStatic([...REAL, ...conflicting], STATIC)).toEqual([...REAL, ...STATIC]);
  });
});
