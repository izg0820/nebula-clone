import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { AgentConfig } from './config';
import { backoffDelayMs, ServerTunnel } from './server-tunnel';

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

  beforeEach((done) => {
    server = new WebSocketServer({ port: 0 }, () => {
      const { port } = server.address() as AddressInfo;
      serverUrl = `ws://127.0.0.1:${port}/agent`;
      done();
    });
  });

  afterEach((done) => {
    server.close(() => done());
  });

  function createConfig(): AgentConfig {
    return {
      serverUrl,
      agentToken: 't'.repeat(24),
      agentId: 'test-agent',
      discoveryIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    };
  }

  test('Authorization 헤더·agentId 쿼리로 연결하고 register를 전송', (done) => {
    const config = createConfig();
    let tunnel: ServerTunnel;

    server.on('connection', (socket, request) => {
      // Assert: 인증 헤더와 agentId 쿼리 확인
      expect(request.headers.authorization).toBe(`Bearer ${config.agentToken}`);
      expect(request.url).toContain('agentId=test-agent');

      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message).toEqual({
          type: 'register',
          devices: [
            { id: 'u1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] },
          ],
        });
        tunnel.close();
        done();
      });
    });

    tunnel = new ServerTunnel(config, {
      onOpen: () => {
        tunnel.sendRegister([
          { id: 'u1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: [] },
        ]);
      },
    });
    tunnel.connect();
  });

  test('미연결 상태 전송은 false 반환 (throw 금지)', () => {
    const tunnel = new ServerTunnel(createConfig(), { onOpen: () => undefined });

    expect(tunnel.sendHeartbeat(['u1'])).toBe(false);
  });

  test('close 후에는 재연결하지 않음', (done) => {
    const config = createConfig();
    let connections = 0;

    server.on('connection', () => {
      connections += 1;
    });

    const tunnel = new ServerTunnel(config, {
      onOpen: () => {
        tunnel.close();
        // 종료 후 재연결이 없는지 백오프 1회분 이상 대기 후 확인
        setTimeout(() => {
          expect(connections).toBe(1);
          done();
        }, 1_200);
      },
    });
    tunnel.connect();
  });
});
