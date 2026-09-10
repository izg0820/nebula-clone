import { EventEmitter } from 'events';
import { AgentFrame } from '@nebula/shared';
import { AndroidStream, AndroidStreamDeps, SocketLike } from './android-stream';
import { ChildLike } from './process-tree';

class FakeChild extends EventEmitter implements ChildLike {
  // pid 없음 — signalProcessTree가 단일 kill 폴백을 타게 (실 kill 방지)
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

class FakeSocket extends EventEmitter implements SocketLike {
  isDestroyed = false;
  destroy(): void {
    this.isDestroyed = true;
  }
}

const PREAMBLE = Buffer.from([
  0x4e, 0x42, 0x4c, 0x41, 0x00, 0x01, 0x01, 0x00,
  0x04, 0xe0, 0x07, 0xb4, 0x00, 0x00, 0x00, 0x00,
]);

function keyPacket(): Buffer {
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]);
  const header = Buffer.alloc(14);
  header[0] = 0x01;
  header.writeUInt16BE(1248, 2);
  header.writeUInt16BE(1972, 4);
  header.writeUInt32BE(1234, 6);
  header.writeUInt32BE(payload.length, 10);
  return Buffer.concat([header, payload]);
}

interface Harness {
  stream: AndroidStream;
  frames: AgentFrame[];
  adbCalls: string[][];
  spawned: FakeChild[];
  sockets: FakeSocket[];
}

const active: AndroidStream[] = [];

function createHarness(overrides: Partial<AndroidStreamDeps> = {}): Harness {
  const frames: AgentFrame[] = [];
  const adbCalls: string[][] = [];
  const spawned: FakeChild[] = [];
  const sockets: FakeSocket[] = [];
  const stream = new AndroidStream(
    {
      adbPath: '/fake/adb',
      serial: 'R5KL803AEAM',
      mirrorDexPath: '/fake/mirror.apk',
      mirrorPort: 8400,
      logDir: '/tmp/nebula-test-logs',
    },
    (frame) => {
      frames.push(frame);
      return true;
    },
    {
      runAdb: overrides.runAdb ?? (async (args) => {
        adbCalls.push([...args]);
        return Buffer.alloc(0);
      }),
      spawnDaemon:
        overrides.spawnDaemon ??
        (() => {
          const child = new FakeChild();
          spawned.push(child);
          return child;
        }),
      connect:
        overrides.connect ??
        (() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }),
    },
  );
  active.push(stream);
  return { stream, frames, adbCalls, spawned, sockets };
}

/** launch의 비동기 준비(runAdb 체인)가 끝나길 대기 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('AndroidStream', () => {
  afterEach(() => {
    for (const stream of active.splice(0)) stream.stop();
    jest.useRealTimers();
  });

  test('기동 시퀀스 — push → 데몬 spawn → forward → 접속, 패킷을 AgentFrame으로 방출', async () => {
    const harness = createHarness();
    harness.stream.start();
    await flush();

    const commands = harness.adbCalls.map((args) => args.join(' '));
    expect(commands[0]).toBe('-s R5KL803AEAM push /fake/mirror.apk /data/local/tmp/nebula-mirror.jar');
    expect(commands[1]).toBe('-s R5KL803AEAM forward tcp:8400 localabstract:nebula-mirror');
    expect(harness.spawned).toHaveLength(1);
    expect(harness.sockets).toHaveLength(1);

    harness.sockets[0].emit('data', Buffer.concat([PREAMBLE, keyPacket()]));

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({
      deviceId: 'R5KL803AEAM',
      isKey: true,
      width: 1248,
      height: 1972,
    });
  });

  test('프리앰블 전 접속 거부(close)는 재접속 — 데몬 listen 지연 흡수', async () => {
    const harness = createHarness();
    harness.stream.start();
    await flush();

    harness.sockets[0].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(harness.sockets).toHaveLength(2);
    harness.sockets[1].emit('data', PREAMBLE);
    expect(harness.sockets[1].isDestroyed).toBe(false);
  });

  test('스트림 활성 후 단선 → 데몬 종료 신호 + 백오프 재기동', async () => {
    const harness = createHarness();
    harness.stream.start();
    await flush();
    harness.sockets[0].emit('data', PREAMBLE);

    harness.sockets[0].emit('close');
    expect(harness.spawned[0].signals).toContain('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(harness.spawned.length).toBe(2);
  }, 10_000);

  test('스트림 손상(매직 불일치)은 재기동 예약', async () => {
    const harness = createHarness();
    harness.stream.start();
    await flush();

    harness.sockets[0].emit('data', Buffer.from('corrupted-garbage-data!!'));

    expect(harness.sockets[0].isDestroyed).toBe(true);
    expect(harness.spawned[0].signals).toContain('SIGTERM');
  });

  test('stop — 소켓 파기 + 데몬 SIGTERM + forward 제거', async () => {
    const harness = createHarness();
    harness.stream.start();
    await flush();

    harness.stream.stop();
    await flush();

    expect(harness.sockets[0].isDestroyed).toBe(true);
    expect(harness.spawned[0].signals).toContain('SIGTERM');
    const commands = harness.adbCalls.map((args) => args.join(' '));
    expect(commands).toContain('-s R5KL803AEAM forward --remove tcp:8400');
  });
});
