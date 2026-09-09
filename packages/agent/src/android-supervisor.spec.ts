import { EventEmitter } from 'events';
import { AndroidSupervisor, AndroidSupervisorDeps } from './android-supervisor';
import { ChildLike } from './process-tree';

class FakeChild extends EventEmitter implements ChildLike {
  // pid 없음 — signalProcessTree가 단일 kill 폴백을 타게 (실 kill 방지)
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface Harness {
  supervisor: AndroidSupervisor;
  adbCalls: string[][];
  spawned: Array<{ command: string; args: readonly string[]; child: FakeChild }>;
  setHealthy: (value: boolean) => void;
}

/** 테스트 종료 시 stopAll — 헬스 폴링 interval이 jest 프로세스를 붙잡지 않게 */
const active: AndroidSupervisor[] = [];

function createHarness(overrides: Partial<AndroidSupervisorDeps> = {}): Harness {
  const adbCalls: string[][] = [];
  const spawned: Harness['spawned'] = [];
  let healthy = true;
  const supervisor = new AndroidSupervisor(
    {
      adbPath: '/fake/adb',
      runnerApkPath: '/fake/runner.apk',
      basePort: 8300,
      logDir: '/tmp/nebula-test-logs',
      controllerToken: 'token-android-test-abcdefgh',
    },
    {
      runAdb: overrides.runAdb ?? (async (args) => {
        adbCalls.push([...args]);
        return Buffer.alloc(0);
      }),
      spawnProcess:
        overrides.spawnProcess ??
        ((command, args) => {
          const child = new FakeChild();
          spawned.push({ command, args, child });
          return child;
        }),
      checkHealth: overrides.checkHealth ?? (async () => healthy),
    },
  );
  active.push(supervisor);
  return { supervisor, adbCalls, spawned, setHealthy: (value) => (healthy = value) };
}

/** launch의 비동기 준비(runAdb 체인)가 끝나길 대기 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('AndroidSupervisor', () => {
  afterEach(() => {
    for (const supervisor of active.splice(0)) supervisor.stopAll();
    jest.useRealTimers();
  });

  test('세션 기동 시퀀스 — stayon → install → forward → force-stop → am instrument', async () => {
    const harness = createHarness();
    harness.supervisor.syncDevices(['R3CX90']);
    await flush();

    const commands = harness.adbCalls.map((args) => args.join(' '));
    expect(commands[0]).toBe('-s R3CX90 shell svc power stayon usb');
    expect(commands[1]).toBe('-s R3CX90 install -r -t -g /fake/runner.apk');
    expect(commands[2]).toBe('-s R3CX90 forward tcp:8300 tcp:8300');
    expect(commands[3]).toBe('-s R3CX90 shell am force-stop com.nebula.controller');

    expect(harness.spawned).toHaveLength(1);
    const { command, args } = harness.spawned[0];
    expect(command).toBe('/fake/adb');
    expect(args.join(' ')).toContain('am instrument -w -r --no-hidden-api-checks');
    expect(args.join(' ')).toContain('-e nebulaToken token-android-test-abcdefgh');
    expect(args.join(' ')).toContain('com.nebula.controller/.ControllerInstrumentation');
  });

  test('resolve는 세션 포트 URL, 기기마다 포트 순차 할당', async () => {
    const harness = createHarness();
    harness.supervisor.syncDevices(['a1', 'a2']);
    await flush();

    expect(harness.supervisor.resolve('a1')).toBe('http://127.0.0.1:8300');
    expect(harness.supervisor.resolve('a2')).toBe('http://127.0.0.1:8301');
    expect(harness.supervisor.resolve('없음')).toBeNull();
  });

  test('러너 exit → 재기동 예약, 재기동은 install 생략', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    harness.supervisor.syncDevices(['a1']);
    await jest.advanceTimersByTimeAsync(20);
    const installCallsBefore = harness.adbCalls.filter((args) => args.includes('install')).length;
    expect(installCallsBefore).toBe(1);

    harness.spawned[0].child.emit('exit', 1);
    await jest.advanceTimersByTimeAsync(3_000);

    expect(harness.spawned).toHaveLength(2);
    const installCallsAfter = harness.adbCalls.filter((args) => args.includes('install')).length;
    expect(installCallsAfter).toBe(1);
  });

  test('기기 소멸 시 force-stop + forward --remove + 세션 제거', async () => {
    const harness = createHarness();
    harness.supervisor.syncDevices(['a1']);
    await flush();
    harness.supervisor.syncDevices([]);
    await flush();

    const commands = harness.adbCalls.map((args) => args.join(' '));
    expect(commands).toContain('-s a1 shell am force-stop com.nebula.controller');
    expect(commands).toContain('-s a1 forward --remove tcp:8300');
    expect(harness.supervisor.resolve('a1')).toBeNull();
  });

  test('헬스 성공 시 isReady, 3연속 실패 시 재기동', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    harness.supervisor.syncDevices(['a1']);
    await jest.advanceTimersByTimeAsync(20);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(harness.supervisor.isReady('a1')).toBe(true);

    harness.setHealthy(false);
    // 실패 3회(30초) + 재기동 백오프(2초) + 준비 체인 여유
    await jest.advanceTimersByTimeAsync(35_000);
    expect(harness.supervisor.isReady('a1')).toBe(false);
    expect(harness.spawned.length).toBeGreaterThan(1);
  });

  test('준비 실패(adb install 오류)는 백오프 재기동으로 수렴', async () => {
    jest.useFakeTimers();
    const failing = createHarness({
      runAdb: async (args) => {
        if (args.includes('install')) throw new Error('INSTALL_FAILED');
        return Buffer.alloc(0);
      },
    });
    failing.supervisor.syncDevices(['a1']);
    await jest.advanceTimersByTimeAsync(20);
    expect(failing.spawned).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(2_100);
    // 두 번째 시도 진입 (여전히 실패하지만 재기동 루프가 도는 것 확인)
    expect(failing.supervisor.resolve('a1')).not.toBeNull();
  });
});
