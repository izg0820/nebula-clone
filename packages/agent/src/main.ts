import { AgentFrame, RegisterDeviceInput } from '@nebula/shared';
import { AdbClient } from './adb-client';
import { AndroidDiscoverySource } from './android-discovery';
import { AndroidStream } from './android-stream';
import { AndroidSupervisor } from './android-supervisor';
import { CommandExecutor } from './command-executor';
import { CompositeResolver } from './composite-resolver';
import { loadConfig } from './config';
import { ControllerEndpointResolver } from './controller-registry';
import { ControllerSupervisor } from './controller-supervisor';
import { IosDiscoverySource } from './device-discovery';
import { DiscoveryAggregator } from './discovery-aggregator';
import { DiscoverySource } from './discovery-source';
import { logger } from './logger';
import { H264Stream } from './h264-stream';
import { ServerTunnel } from './server-tunnel';
import { StreamManager } from './stream-manager';

/** Controller 준비 상태 태그 — 서버에서 tags:["controller-ready"]로 점유 필터 가능 */
const READY_TAG = 'controller-ready';

/** iOS 수퍼바이저 — NEBULA_XCODEBUILD_ENABLED=true일 때만, 아니면 null(iOS 제어 비활성) */
function createSupervisor(config: ReturnType<typeof loadConfig>): ControllerSupervisor | null {
  if (!config.supervisor) return null;
  return new ControllerSupervisor({
    ...config.supervisor,
    controllerToken: config.controllerToken,
  });
}

/**
 * 미러링 관리자 — 플랫폼별 스트림 팩토리 주입 (미러링은 필수, 항상 구동).
 * 경로는 config가 레포 빌드 산출물로 기본값 계산 — 산출물 미빌드 시 런타임이 재시도·로깅
 */
function createStreamManager(
  config: ReturnType<typeof loadConfig>,
  tunnel: ServerTunnel,
  discovery: DiscoveryAggregator,
): StreamManager {
  const helperPath = config.mirrorHelperPath;
  const android = config.android;

  const sendFrame = (frame: AgentFrame): boolean => tunnel.sendFrame(frame);
  // 기기별 미러링 포트 고정 할당 — 같은 기기는 재발견돼도 같은 포트 (잔존 forward와의 충돌 방지)
  const mirrorPorts = new Map<string, number>();
  const allocateMirrorPort = (serial: string): number => {
    const existing = mirrorPorts.get(serial);
    if (existing !== undefined) return existing;
    const port = (android?.mirrorBasePort ?? 0) + mirrorPorts.size;
    mirrorPorts.set(serial, port);
    return port;
  };

  return new StreamManager((deviceId) => {
    const device = discovery.devices.find((item) => item.id === deviceId);
    if (!device) return null;
    if (device.platform === 'android') {
      if (!android) return null; // adb 없으면 android 기기 자체가 발견 안 됨 — 도달하지 않음
      return new AndroidStream(
        {
          adbPath: android.adbPath,
          serial: deviceId,
          mirrorDexPath: android.mirrorDexPath,
          mirrorPort: allocateMirrorPort(deviceId),
          logDir: android.logDir,
          tuning: android.mirrorTuning,
        },
        sendFrame,
      );
    }
    // iOS: mirror-helper의 캡처 장치 매칭(--name)에 기기 이름 사용
    return new H264Stream({ helperPath, deviceName: device.name, deviceId }, sendFrame);
  });
}

/** 발견 소스 구성 — iOS는 항상, Android는 adb가 설치돼 있으면 (config.android) */
function createDiscoverySources(config: ReturnType<typeof loadConfig>): DiscoverySource[] {
  const sources: DiscoverySource[] = [new IosDiscoverySource()];
  if (config.android) {
    sources.push(new AndroidDiscoverySource(new AdbClient(config.android.adbPath)));
  }
  return sources;
}

/** Android 러너 수퍼바이저 — adb 있으면 항상 (config.android는 adb 없을 때만 null) */
function createAndroidSupervisor(
  config: ReturnType<typeof loadConfig>,
): AndroidSupervisor | null {
  if (!config.android) return null;
  return new AndroidSupervisor({
    adbPath: config.android.adbPath,
    runnerApkPath: config.android.runnerApkPath,
    basePort: config.android.basePort,
    logDir: config.android.logDir,
    controllerToken: config.controllerToken,
    tuning: config.android.supervisorTuning,
    runnerTuning: config.android.runnerTuning,
  });
}

/** 준비된 기기에 READY_TAG 부여 (매 등록 주기마다 재계산 — 자가 치유) */
function withReadinessTag(
  devices: readonly RegisterDeviceInput[],
  resolver: ControllerEndpointResolver,
): readonly RegisterDeviceInput[] {
  return devices.map((device) => {
    if (!resolver.isReady(device.id)) return device;
    if (device.tags.includes(READY_TAG)) return device;
    return { ...device, tags: [...device.tags, READY_TAG] };
  });
}

/** Agent 데몬 — 기기 발견 → 서버 등록 → 하트비트 반복 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.info({ agentId: config.agentId, serverUrl: config.serverUrl }, 'Agent 시작');

  const discovery = new DiscoveryAggregator(createDiscoverySources(config), config.staticDevices);
  const supervisor = createSupervisor(config);
  const androidSupervisor = createAndroidSupervisor(config);
  const resolver: ControllerEndpointResolver = new CompositeResolver([
    ...(supervisor ? [supervisor] : []),
    ...(androidSupervisor ? [androidSupervisor] : []),
  ]);
  const executor = new CommandExecutor(resolver, config.controllerToken);
  let isDiscoveryInFlight = false;

  const tunnel = new ServerTunnel(config, {
    onOpen: () => {
      // 재연결 직후 즉시 재등록 — 서버가 오프라인 처리했을 수 있음
      void discoverAndRegister();
    },
    onCommand: (command) => executor.execute(command),
    // 점유가 끝나면 그 세대의 대기 명령을 폐기 — 인계 이후 유령 입력 차단
    onOccupancyEnded: (deviceId, occupantId) => executor.revokeOccupation(deviceId, occupantId),
    // 단선 중 서버에서 점유가 바뀌었을 수 있으므로 세대를 전부 버림 (재연결 후 새 명령부터 유효)
    onDisconnect: () => executor.revokeAllOccupations(),
  });
  const streamManager = createStreamManager(config, tunnel, discovery);

  /** 발견 → 등록. 인플라이트 가드로 동시 실행·늦은 결과 덮어쓰기 방지 */
  async function discoverAndRegister(): Promise<void> {
    if (isDiscoveryInFlight) {
      logger.debug('발견 진행 중 — 이번 회차 생략');
      return;
    }
    isDiscoveryInFlight = true;
    try {
      const shouldRegister = await discovery.refresh();

      // 등록 여부와 무관하게 세션 동기화 — 연속 실패 임계로 목록이 비워진 경우에도 세션 정리
      const iosDeviceIds = discovery.discoveredIds('ios');
      const androidDeviceIds = discovery.discoveredIds('android');
      supervisor?.syncDevices(iosDeviceIds);
      androidSupervisor?.syncDevices(androidDeviceIds);
      // 미러링 상시 구동 — 시청자 없어도 캡처 유지 (iOS·Android 공통, 팩토리가 플랫폼 분기)
      streamManager.syncAlwaysOn([...iosDeviceIds, ...androidDeviceIds]);
      if (!shouldRegister) return;

      const sent = tunnel.sendRegister(withReadinessTag(discovery.devices, resolver));
      if (!sent) {
        logger.warn('터널 미연결로 등록 유실 — 재연결 시 onOpen에서 재등록됨');
        return;
      }
      logger.info({ count: discovery.devices.length }, '기기 등록 전송');
    } finally {
      isDiscoveryInFlight = false;
    }
  }

  tunnel.connect();

  const discoveryTimer = setInterval(() => void discoverAndRegister(), config.discoveryIntervalMs);
  const heartbeatTimer = setInterval(() => {
    const deviceIds = discovery.devices.map((device) => device.id);
    if (deviceIds.length === 0) return;
    tunnel.sendHeartbeat(deviceIds);
  }, config.heartbeatIntervalMs);

  // 자식 프로세스 종료 대기 상한 — 수퍼바이저 SIGKILL 에스컬레이션(3초)보다 길게
  const SHUTDOWN_GRACE_MS = 5_000;
  let isShuttingDown = false;

  const shutdown = (): void => {
    // 신호 중복(SIGINT 연타 등)으로 종료 절차가 재진입하지 않도록
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Agent 종료');
    clearInterval(discoveryTimer);
    clearInterval(heartbeatTimer);
    streamManager.stopAll();
    supervisor?.stopAll();
    androidSupervisor?.stopAll();
    tunnel.close();
    // 즉시 exit 금지 — 자식(xcodebuild·iproxy·mirror-helper)이 고아로 남음.
    // 헬퍼도 반드시 대기: SIGTERM 미응답 시 SIGKILL 에스컬레이션이 unref 타이머라 exit하면 소멸됨
    void (async (): Promise<void> => {
      await Promise.all([
        supervisor?.awaitTermination(SHUTDOWN_GRACE_MS),
        androidSupervisor?.awaitTermination(SHUTDOWN_GRACE_MS),
        streamManager.awaitTermination(SHUTDOWN_GRACE_MS),
      ]);
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 데몬 안전망 — 인터벌 콜백 등에서 새어나온 예외로 조용히 죽지 않도록
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ err: reason }, '처리되지 않은 Promise 거부');
  });
  process.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, '처리되지 않은 예외 — 종료 (감시자가 재기동)');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Agent 기동 실패');
  process.exit(1);
});
