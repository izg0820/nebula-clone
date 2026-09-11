import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { CommandMessage } from '@nebula/shared';
import { CommandExecutor } from './command-executor';
import { ControllerEndpointResolver } from './controller-registry';

function tapCommand(
  deviceId: string,
  requestId: string,
  occupantId = 'occupant-1',
): CommandMessage {
  return {
    type: 'command',
    requestId,
    deviceId,
    occupantId,
    action: { kind: 'tap', x: 1, y: 2 },
  };
}

/** 조건이 참이 될 때까지 대기 — 첫 명령이 실제로 Controller에 나간 뒤를 관측하려고 사용 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('대기 조건이 만족되지 않음');
}

/** deviceId → 포트 매핑을 준비 완료 상태의 resolver로 (테스트용 고정 Controller 주소) */
function resolverFor(ports: Record<string, number>): ControllerEndpointResolver {
  return {
    resolve: (deviceId) => (deviceId in ports ? `http://127.0.0.1:${ports[deviceId]}` : null),
    isReady: (deviceId) => deviceId in ports,
  };
}

describe('CommandExecutor', () => {
  test('Controller 미등록 기기는 실패 outcome (throw 금지)', async () => {
    const executor = new CommandExecutor(resolverFor({}));

    const outcome = await executor.execute(tapCommand('unknown', 'r1'));

    expect(outcome.ok).toBe(false);
  });

  test('Controller 준비 전이면 즉시 실패 outcome', async () => {
    const notReadyResolver: ControllerEndpointResolver = {
      resolve: () => 'http://127.0.0.1:9999',
      isReady: () => false,
    };
    const executor = new CommandExecutor(notReadyResolver);

    const outcome = await executor.execute(tapCommand('u1', 'r1'));

    expect(outcome).toEqual({ ok: false, error: 'controller 준비 중 (러너 기동 대기)' });
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
      const executor = new CommandExecutor(resolverFor({ u1: port }));

      const outcomes = await Promise.all([
        executor.execute(tapCommand('u1', 'r1')),
        executor.execute(tapCommand('u1', 'r2')),
        executor.execute(tapCommand('u1', 'r3')),
      ]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(maxConcurrent).toBe(1);
    });
  });

  describe('점유 세대 검증 (응답 지연 Controller 연동)', () => {
    let server: Server;
    let port: number;
    let receivedPaths: string[];
    let releaseFirst: (() => void) | null;

    /** 붙잡아 둔 첫 요청 응답 — 두 번 호출돼도 안전하도록 소비 후 비움 */
    const releaseHeld = (): void => {
      const respond = releaseFirst;
      releaseFirst = null;
      respond?.();
    };

    beforeEach((done) => {
      receivedPaths = [];
      releaseFirst = null;
      server = createServer((request, response) => {
        receivedPaths.push(request.url ?? '');
        const respond = (): void => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        };
        request.resume();
        // 첫 요청은 테스트가 풀어줄 때까지 붙잡아 둔다 — 그 사이 뒤 명령이 큐에서 대기
        if (receivedPaths.length === 1) {
          releaseFirst = respond;
          return;
        }
        respond();
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        done();
      });
    });

    afterEach((done) => {
      releaseHeld();
      server.close(() => done());
    });

    test('대기 중 점유가 끝나면 이전 점유자의 명령은 Controller에 닿지 않음', async () => {
      const executor = new CommandExecutor(resolverFor({ u1: port }));
      const inFlight = executor.execute(tapCommand('u1', 'r1', 'occupant-A'));
      const queued = executor.execute(tapCommand('u1', 'r2', 'occupant-A'));
      await waitUntil(() => receivedPaths.length === 1);

      executor.revokeOccupation('u1', 'occupant-A');
      releaseHeld();

      await inFlight;
      expect(await queued).toEqual({ ok: false, error: 'occupation_ended' });
      // 붙잡힌 첫 요청 1건뿐 — 대기하던 두 번째는 전송조차 되지 않음
      expect(receivedPaths).toHaveLength(1);
    });

    test('새 점유자의 명령이 도착하면 이전 세대의 대기 명령이 무효화됨', async () => {
      const executor = new CommandExecutor(resolverFor({ u1: port }));
      const inFlight = executor.execute(tapCommand('u1', 'r1', 'occupant-A'));
      const staleQueued = executor.execute(tapCommand('u1', 'r2', 'occupant-A'));
      await waitUntil(() => receivedPaths.length === 1);
      const freshQueued = executor.execute(tapCommand('u1', 'r3', 'occupant-B'));

      releaseHeld();

      await inFlight;
      expect(await staleQueued).toEqual({ ok: false, error: 'occupation_ended' });
      expect((await freshQueued).ok).toBe(true);
      // 붙잡힌 첫 요청 + 새 세대 명령 = 2건 (옛 세대 대기 명령은 폐기)
      expect(receivedPaths).toHaveLength(2);
    });

    test('터널 단선은 모든 세대를 폐기 — 재연결 전 대기 명령 실행 금지', async () => {
      const executor = new CommandExecutor(resolverFor({ u1: port }));
      const inFlight = executor.execute(tapCommand('u1', 'r1', 'occupant-A'));
      const queued = executor.execute(tapCommand('u1', 'r2', 'occupant-A'));
      await waitUntil(() => receivedPaths.length === 1);

      executor.revokeAllOccupations();
      releaseHeld();

      await inFlight;
      expect(await queued).toEqual({ ok: false, error: 'occupation_ended' });
      expect(receivedPaths).toHaveLength(1);
    });

    test('다른 세대의 종료 통지는 현재 세대를 건드리지 않음', async () => {
      const executor = new CommandExecutor(resolverFor({ u1: port }));
      const inFlight = executor.execute(tapCommand('u1', 'r1', 'occupant-A'));
      const queued = executor.execute(tapCommand('u1', 'r2', 'occupant-A'));
      await waitUntil(() => receivedPaths.length === 1);

      executor.revokeOccupation('u1', 'occupant-OLD');
      releaseHeld();

      await inFlight;
      expect((await queued).ok).toBe(true);
      expect(receivedPaths).toHaveLength(2);
    });
  });
});
