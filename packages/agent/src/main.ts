import { RegisterDeviceInput } from '@nebula/shared';
import { CommandExecutor } from './command-executor';
import { loadConfig } from './config';
import { ControllerEndpointResolver, StaticControllerRegistry } from './controller-registry';
import { ControllerSupervisor } from './controller-supervisor';
import { discoverDevices, mergeWithStatic } from './device-discovery';
import { DiscoveryState } from './discovery-state';
import { logger } from './logger';
import { ServerTunnel } from './server-tunnel';
import { StreamManager } from './stream-manager';

/** Controller 준비 상태 태그 — 서버에서 tags:["controller-ready"]로 점유 필터 가능 */
const READY_TAG = 'controller-ready';

/** 수퍼바이저 모드면 생성, 아니면 null (정적 포트 매핑 사용) */
function createSupervisor(config: ReturnType<typeof loadConfig>): ControllerSupervisor | null {
  if (!config.supervisor) return null;
  if (config.controllerPorts.size > 0) {
    logger.warn('수퍼바이저 모드에서는 NEBULA_CONTROLLER_PORTS 무시됨');
  }
  return new ControllerSupervisor(config.supervisor);
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

  const discoveryState = new DiscoveryState();
  const supervisor = createSupervisor(config);
  const resolver: ControllerEndpointResolver =
    supervisor ?? new StaticControllerRegistry(config.controllerPorts);
  const executor = new CommandExecutor(resolver);
  // 정적 기기는 실기기가 아니므로 수퍼바이저(xcodebuild) 대상에서 제외
  const staticDeviceIds = new Set(config.staticDevices.map((device) => device.id));
  let isDiscoveryInFlight = false;

  const tunnel = new ServerTunnel(config, {
    onOpen: () => {
      // 재연결 직후 즉시 재등록 — 서버가 오프라인 처리했을 수 있음
      void discoverAndRegister();
    },
    onCommand: (command) => executor.execute(command),
    onStreamControl: (deviceId, shouldStart) => {
      if (shouldStart) {
        streamManager.start(deviceId);
        return;
      }
      streamManager.stop(deviceId);
    },
  });
  const streamManager = new StreamManager(resolver, (frame) => tunnel.sendFrame(frame));

  /** 발견 → 등록. 인플라이트 가드로 동시 실행·늦은 결과 덮어쓰기 방지 */
  async function discoverAndRegister(): Promise<void> {
    if (isDiscoveryInFlight) {
      logger.debug('발견 진행 중 — 이번 회차 생략');
      return;
    }
    isDiscoveryInFlight = true;
    try {
      const result = mergeWithStatic(await discoverDevices(), config.staticDevices);
      const shouldRegister = discoveryState.apply(result);

      // 등록 여부와 무관하게 세션 동기화 — 연속 실패 임계로 목록이 비워진 경우에도 세션 정리
      supervisor?.syncDevices(
        discoveryState.current
          .map((device) => device.id)
          .filter((id) => !staticDeviceIds.has(id)),
      );
      if (!shouldRegister) return;

      const sent = tunnel.sendRegister(withReadinessTag(discoveryState.current, resolver));
      if (!sent) {
        logger.warn('터널 미연결로 등록 유실 — 재연결 시 onOpen에서 재등록됨');
        return;
      }
      logger.info({ count: discoveryState.current.length }, '기기 등록 전송');
    } finally {
      isDiscoveryInFlight = false;
    }
  }

  tunnel.connect();

  const discoveryTimer = setInterval(() => void discoverAndRegister(), config.discoveryIntervalMs);
  const heartbeatTimer = setInterval(() => {
    const deviceIds = discoveryState.current.map((device) => device.id);
    if (deviceIds.length === 0) return;
    tunnel.sendHeartbeat(deviceIds);
  }, config.heartbeatIntervalMs);

  const shutdown = (): void => {
    logger.info('Agent 종료');
    clearInterval(discoveryTimer);
    clearInterval(heartbeatTimer);
    streamManager.stopAll();
    supervisor?.stopAll();
    tunnel.close();
    process.exit(0);
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
