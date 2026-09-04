import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { CommandMessage } from '@nebula/shared';
import { CommandExecutor } from './command-executor';

function tapCommand(deviceId: string, requestId: string): CommandMessage {
  return { type: 'command', requestId, deviceId, action: { kind: 'tap', x: 1, y: 2 } };
}

describe('CommandExecutor', () => {
  test('Controller 미등록 기기는 실패 outcome (throw 금지)', async () => {
    const executor = new CommandExecutor(new Map());

    const outcome = await executor.execute(tapCommand('unknown', 'r1'));

    expect(outcome.ok).toBe(false);
  });

  describe('기기별 직렬화 (실제 HTTP 서버 연동)', () => {
    let server: Server;
    let port: number;
    let concurrent: number;
    let maxConcurrent: number;

    beforeEach((done) => {
      concurrent = 0;
      maxConcurrent = 0;
      server = createServer((request, response) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // 처리 지연으로 동시 유입 여부 관측
        setTimeout(() => {
          concurrent -= 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        }, 80);
        request.resume();
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        done();
      });
    });

    afterEach((done) => {
      server.close(() => done());
    });

    test('같은 기기의 명령은 동시에 나가지 않음', async () => {
      const executor = new CommandExecutor(new Map([['u1', port]]));

      const outcomes = await Promise.all([
        executor.execute(tapCommand('u1', 'r1')),
        executor.execute(tapCommand('u1', 'r2')),
        executor.execute(tapCommand('u1', 'r3')),
      ]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(maxConcurrent).toBe(1);
    });
  });
});
