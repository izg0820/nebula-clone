import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { AgentFrame } from '@nebula/shared';
import { StaticControllerRegistry } from './controller-registry';
import { StreamManager } from './stream-manager';

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0];

describe('StreamManager (실제 HTTP Controller 연동)', () => {
  let server: Server;
  let port: number;
  let requestCount: number;

  beforeEach((done) => {
    requestCount = 0;
    server = createServer((request, response) => {
      requestCount += 1;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          jpegBase64: Buffer.from(JPEG_BYTES).toString('base64'),
          widthPt: 430,
          heightPt: 932,
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(() => done());
  });

  test('start → 프레임 연속 푸시, stop → 루프 종료', async () => {
    const frames: AgentFrame[] = [];
    const manager = new StreamManager(
      new StaticControllerRegistry(new Map([['u1', port]])),
      (frame) => {
        frames.push(frame);
        return true;
      },
      { helperPath: null, resolveDeviceName: () => null },
    );

    manager.handleStreamControl('u1', true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    manager.handleStreamControl('u1', false);
    const countAtStop = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 여러 프레임이 순차 푸시됐고, stop 이후엔 최대 in-flight 1개만 추가될 수 있음
    expect(countAtStop).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeLessThanOrEqual(countAtStop + 1);
    expect(frames[0]).toMatchObject({ deviceId: 'u1', width: 430, height: 932, isKey: true });
    expect(Array.from(frames[0].payload)).toEqual(JPEG_BYTES);
  });

  test('중복 start는 루프를 늘리지 않음', async () => {
    const manager = new StreamManager(
      new StaticControllerRegistry(new Map([['u1', port]])),
      () => true,
      { helperPath: null, resolveDeviceName: () => null },
    );

    manager.handleStreamControl('u1', true);
    manager.handleStreamControl('u1', true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    manager.stopAll();
    const count = requestCount;

    // 단일 루프면 250ms 동안 대략 수 회 — 이중 루프면 2배 이상으로 관측됨
    expect(count).toBeLessThanOrEqual(10);
  });

  test('Controller 미등록 기기는 재시도 대기로만 돌고 프레임 없음', async () => {
    const frames: AgentFrame[] = [];
    const manager = new StreamManager(
      new StaticControllerRegistry(new Map()),
      (frame) => {
        frames.push(frame);
        return true;
      },
      { helperPath: null, resolveDeviceName: () => null },
    );

    manager.handleStreamControl('unknown', true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager.stopAll();

    expect(frames).toHaveLength(0);
  });
});

describe('StreamManager 상시 구동 정책', () => {
  test('JPEG 모드(helperPath 없음)에서 syncAlwaysOn은 아무것도 시작하지 않음', async () => {
    const frames: AgentFrame[] = [];
    const manager = new StreamManager(
      new StaticControllerRegistry(new Map()),
      (frame) => {
        frames.push(frame);
        return true;
      },
      { helperPath: null, resolveDeviceName: () => null },
    );

    manager.syncAlwaysOn(['u1', 'u2']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.stopAll();

    expect(frames).toHaveLength(0);
  });
});
