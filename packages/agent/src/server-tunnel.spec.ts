import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { AgentConfig } from './config';
import { backoffDelayMs, ServerTunnel, TunnelTimings } from './server-tunnel';

describe('backoffDelayMs', () => {
  test('지수 증가 후 상한에서 고정', () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(10)).toBe(30_000);
  });
});

describe('ServerTunnel (실제 WS 서버 연동)', () => {
  let server: WebSocketServer;
  let serverUrl: string;
  let tunnel: ServerTunnel | null;

  beforeEach((done) => {
    tunnel = null;
    server = new WebSocketServer({ port: 0 }, () => {
      const { port } = server.address() as AddressInfo;
      serverUrl = `ws://127.0.0.1:${port}/agent`;
      done();
    });
  });

  afterEach((done) => {
    tunnel?.close();
    server.close(() => done());
  });

  function createConfig(): AgentConfig {
    return {
      serverUrl,
      agentToken: 't'.repeat(24),
      agentId: 'test-agent',
      discoveryIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      controllerPorts: new Map<string, number>(),
      staticDevices: [],
      supervisor: null,
      mirrorHelperPath: null,
      controllerToken: null,
    };
  }

  function createTunnel(timings: TunnelTimings = {}): ServerTunnel {
    tunnel = new ServerTunnel(createConfig(), { onOpen: () => undefined }, timings);
    return tunnel;
  }

  test('Authorization 헤더·agentId 쿼리로 연결하고 register를 전송', (done) => {
    const config = createConfig();

    server.on('connection', (socket, request) => {
      expect(request.headers.authorization).toBe(`Bearer ${config.agentToken}`);
      expect(request.url).toContain('agentId=test-agent');

      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message).toMatchObject({
          type: 'register',
          devices: [
            { id: 'u1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] },
          ],
        });
        // 스펙 교환 포함 확인 — 서버의 혼합 버전 가드 전제
        expect(message.capabilities).toContain('pressButton');
        done();
      });
    });

    tunnel = new ServerTunnel(config, {
      onOpen: () => {
        tunnel?.sendRegister([
          { id: 'u1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] },
        ]);
      },
    });
    tunnel.connect();
  });

  test('미연결 상태 전송은 false 반환 (throw 금지)', () => {
    expect(createTunnel().sendHeartbeat(['u1'])).toBe(false);
  });

  test('즉시 거부되는 연결(open 직후 close)에서 백오프 카운터가 리셋되지 않음', (done) => {
    // 서버가 핸드셰이크 후 즉시 종료 — 4401과 같은 순서(open → close)를 비종단 코드로 재현
    server.on('connection', (socket) => {
      socket.close(4402, 'rejected');
    });

    const rejected = createTunnel();
    rejected.connect();

    // 1차 재시도(1초) 후 2차 거부까지 관찰 — open이 리셋했다면 attemptCount가 0·1에 머묾
    setTimeout(() => {
      expect(rejected.attemptCount).toBeGreaterThanOrEqual(2);
      done();
    }, 1_600);
  }, 10_000);

  test('종단 close 코드(4401)는 즉시 재시도하지 않음', (done) => {
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      socket.close(4401, 'unauthorized');
    });

    createTunnel().connect();

    // 종단 코드는 상한 간격(30초) 재시도 — 1.5초 안에 재연결이 없어야 함
    setTimeout(() => {
      expect(connections).toBe(1);
      done();
    }, 1_500);
  }, 10_000);

  test('주기 ping 전송 (keepalive)', (done) => {
    server.on('connection', (socket) => {
      socket.on('ping', () => done());
    });

    createTunnel({ pingIntervalMs: 100 }).connect();
  }, 10_000);

  test('서버 command 수신 → onCommand 실행 → commandResult 회신', (done) => {
    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'command',
          requestId: 'req-1',
          deviceId: 'u1',
          action: { kind: 'tap', x: 10, y: 20 },
        }),
      );
      socket.on('message', (data) => {
        expect(JSON.parse(data.toString())).toEqual({
          type: 'commandResult',
          requestId: 'req-1',
          outcome: { ok: true, result: 'tapped' },
        });
        done();
      });
    });

    tunnel = new ServerTunnel(createConfig(), {
      onOpen: () => undefined,
      onCommand: async (command) => {
        expect(command.action).toEqual({ kind: 'tap', x: 10, y: 20 });
        return { ok: true, result: 'tapped' };
      },
    });
    tunnel.connect();
  }, 10_000);

  test('onCommand가 예외를 던져도 실패 outcome으로 회신', (done) => {
    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({ type: 'command', requestId: 'req-2', deviceId: 'u1', action: { kind: 'uiDump' } }),
      );
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message.requestId).toBe('req-2');
        expect(message.outcome.ok).toBe(false);
        done();
      });
    });

    tunnel = new ServerTunnel(createConfig(), {
      onOpen: () => undefined,
      onCommand: () => Promise.reject(new Error('boom')),
    });
    tunnel.connect();
  }, 10_000);

  test('close 후에는 재연결하지 않음', (done) => {
    let connections = 0;
    server.on('connection', () => {
      connections += 1;
    });

    const closable = new ServerTunnel(createConfig(), {
      onOpen: () => {
        closable.close();
        setTimeout(() => {
          expect(connections).toBe(1);
          done();
        }, 1_200);
      },
    });
    tunnel = closable;
    closable.connect();
  }, 10_000);
});
