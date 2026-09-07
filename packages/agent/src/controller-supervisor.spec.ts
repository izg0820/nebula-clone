import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChildLike, ControllerSupervisor, SupervisorConfig } from './controller-supervisor';

/** kill 기록하는 가짜 자식 프로세스 (pid 없음 → 그룹 kill 대신 단일 kill 폴백 경로) */
class FakeChild extends EventEmitter implements ChildLike {
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

const CONFIG: SupervisorConfig = {
  projectPath: '/path/NebulaController.xcodeproj',
  scheme: 'NebulaController',
  basePort: 8200,
  derivedDataDir: join(tmpdir(), 'nebula-test-dd'),
  logDir: join(tmpdir(), 'nebula-test-logs'),
};

interface Harness {
  supervisor: ControllerSupervisor;
  spawned: Array<{ command: string; args: readonly string[]; child: FakeChild }>;
  setHealthy: (value: boolean) => void;
  /** 수동 resolve용 — stale 헬스 응답 재현 */
  pendingHealthResolvers: Array<(value: boolean) => void>;
  useManualHealth: () => void;
}

function createHarness(): Harness {
  const spawned: Harness['spawned'] = [];
  const pendingHealthResolvers: Array<(value: boolean) => void> = [];
  let isHealthy = false;
  let isManual = false;

  const supervisor = new ControllerSupervisor(CONFIG, {
    spawnProcess: (command, args) => {
      const child = new FakeChild();
      spawned.push({ command, args, child });
      return child;
    },
    checkHealth: () => {
      if (!isManual) return Promise.resolve(isHealthy);
      return new Promise<boolean>((resolve) => pendingHealthResolvers.push(resolve));
    },
  });
  return {
    supervisor,
    spawned,
    pendingHealthResolvers,
    setHealthy: (value: boolean) => {
      isHealthy = value;
    },
    useManualHealth: () => {
      isManual = true;
    },
  };
}

/** 헬스 폴링 1회 진행 (10초) + 마이크로태스크 드레인 */
async function tickHealth(): Promise<void> {
  jest.advanceTimersByTime(10_000);
  await Promise.resolve();
  await Promise.resolve();
}

describe('ControllerSupervisor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('syncDevices는 기기별 xcodebuild(-derivedDataPath 격리) + iproxy를 포트 순차 할당으로 기동', () => {
    const { supervisor, spawned } = createHarness();

    supervisor.syncDevices(['udid-1', 'udid-2']);

    expect(spawned.map((s) => s.command)).toEqual(['xcodebuild', 'iproxy', 'xcodebuild', 'iproxy']);
    expect(spawned[0].args).toContain('id=udid-1');
    // 기기별 DerivedData 격리 — 동시 빌드 DB 경합 방지
    expect(spawned[0].args).toContain(join(CONFIG.derivedDataDir, 'udid-1'));
    expect(spawned[2].args).toContain(join(CONFIG.derivedDataDir, 'udid-2'));
    expect(spawned[1].args).toEqual(['8200', '8100', '-u', 'udid-1']);
    expect(spawned[3].args).toEqual(['8201', '8100', '-u', 'udid-2']);
    expect(supervisor.resolve('udid-1')).toBe('http://127.0.0.1:8200');
  });

  test('헬스 성공 시 준비 상태, 준비 전 실패는 재기동 사유 아님', async () => {
    const { supervisor, spawned, setHealthy } = createHarness();
    supervisor.syncDevices(['udid-1']);

    await tickHealth();
    await tickHealth();
    await tickHealth();
    expect(supervisor.isReady('udid-1')).toBe(false);
    expect(spawned).toHaveLength(2);

    setHealthy(true);
    await tickHealth();
    expect(supervisor.isReady('udid-1')).toBe(true);
  });

  test('준비 후 헬스 연속 실패 시 프로세스 재기동', async () => {
    const { supervisor, spawned, setHealthy } = createHarness();
    supervisor.syncDevices(['udid-1']);
    setHealthy(true);
    await tickHealth();
    expect(supervisor.isReady('udid-1')).toBe(true);

    setHealthy(false);
    await tickHealth();
    await tickHealth();
    await tickHealth();

    expect(spawned[0].child.killedWith).toBe('SIGTERM');
    expect(spawned[1].child.killedWith).toBe('SIGTERM');

    jest.advanceTimersByTime(60_000);
    expect(spawned).toHaveLength(4);
  });

  test('자식 exit 시 백오프 재기동, 옛 세대 exit는 무시', () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1']);

    spawned[0].child.emit('exit', 1);
    jest.advanceTimersByTime(2_000);
    expect(spawned).toHaveLength(4);

    spawned[1].child.emit('exit', 0);
    jest.advanceTimersByTime(120_000);
    expect(spawned).toHaveLength(4);
  });

  test("spawn 실패('error' 이벤트)도 throw 없이 백오프 재기동으로 수렴", () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1']);

    // ENOENT — 'exit' 없이 'error'만 방출되는 경우
    expect(() => spawned[1].child.emit('error', new Error('spawn iproxy ENOENT'))).not.toThrow();

    jest.advanceTimersByTime(2_000);
    expect(spawned).toHaveLength(4);
  });

  test('teardown 후 늦게 도착한 healthy 응답이 죽은 세션을 ready로 만들지 않음', async () => {
    const { supervisor, spawned, pendingHealthResolvers, useManualHealth } = createHarness();
    useManualHealth();
    supervisor.syncDevices(['udid-1']);

    // 헬스 요청이 in-flight 상태로 대기
    jest.advanceTimersByTime(10_000);
    expect(pendingHealthResolvers).toHaveLength(1);

    // 그 사이 러너 사망 → teardown + 백오프 대기
    spawned[0].child.emit('exit', 1);

    // 늦은 healthy 응답 도착 — 백오프 창에서 무시돼야 함
    pendingHealthResolvers[0](true);
    await Promise.resolve();
    await Promise.resolve();

    expect(supervisor.isReady('udid-1')).toBe(false);
  });

  test('기기 제거 시 세션 정리 + 포트 반납·재사용, stopAll은 전체 종료', () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1', 'udid-2']);

    supervisor.syncDevices(['udid-2']);
    expect(spawned[0].child.killedWith).toBe('SIGTERM');
    expect(supervisor.resolve('udid-1')).toBeNull();

    // 반납된 8200 포트가 새 기기에 재사용됨 (단조 증가 고갈 방지)
    supervisor.syncDevices(['udid-2', 'udid-3']);
    expect(supervisor.resolve('udid-3')).toBe('http://127.0.0.1:8200');

    supervisor.stopAll();
    expect(supervisor.resolve('udid-2')).toBeNull();
    expect(supervisor.resolve('udid-3')).toBeNull();
  });

  test('정리된 세션의 자식 exit는 재기동을 유발하지 않음', () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1']);
    supervisor.syncDevices([]);

    spawned[0].child.emit('exit', 143);
    jest.advanceTimersByTime(120_000);

    expect(spawned).toHaveLength(2);
  });

  test('spawnProcess 동기 throw 시 데몬이 죽지 않고 백오프 재기동으로 수렴', () => {
    const spawned: FakeChild[] = [];
    let shouldThrow = true;
    const supervisor = new ControllerSupervisor(CONFIG, {
      spawnProcess: () => {
        if (shouldThrow) throw new Error('EMFILE: too many open files');
        const child = new FakeChild();
        spawned.push(child);
        return child;
      },
      checkHealth: () => Promise.resolve(true),
    });

    expect(() => supervisor.syncDevices(['udid-1'])).not.toThrow();
    expect(spawned).toHaveLength(0);

    // 백오프(2초) 후 재기동에서 정상 spawn — 세션이 wedge되지 않음
    shouldThrow = false;
    jest.advanceTimersByTime(2_000);
    expect(spawned).toHaveLength(2);
  });

  test('awaitTermination — 유예 내 미종료 자식에 SIGKILL 에스컬레이션', async () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1']);
    supervisor.stopAll();
    expect(spawned[0].child.killedWith).toBe('SIGTERM');

    const waiting = supervisor.awaitTermination(1_000);
    await jest.advanceTimersByTimeAsync(1_100);
    await waiting;

    expect(spawned[0].child.killedWith).toBe('SIGKILL');
    expect(spawned[1].child.killedWith).toBe('SIGKILL');
  });

  test('awaitTermination — 자식이 이미 종료됐으면 즉시 반환·SIGKILL 없음', async () => {
    const { supervisor, spawned } = createHarness();
    supervisor.syncDevices(['udid-1']);
    supervisor.stopAll();
    for (const entry of spawned) entry.child.emit('exit', 0);

    await supervisor.awaitTermination(1_000);

    expect(spawned[0].child.killedWith).toBe('SIGTERM');
    expect(spawned[1].child.killedWith).toBe('SIGTERM');
  });
});
