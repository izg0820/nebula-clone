import { loadConfig } from './config';
import { discoverDevices } from './device-discovery';
import { DiscoveryState } from './discovery-state';
import { logger } from './logger';
import { ServerTunnel } from './server-tunnel';

/** Agent 데몬 — 기기 발견 → 서버 등록 → 하트비트 반복 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.info({ agentId: config.agentId, serverUrl: config.serverUrl }, 'Agent 시작');

  const discoveryState = new DiscoveryState();
  let isDiscoveryInFlight = false;

  const tunnel = new ServerTunnel(config, {
    onOpen: () => {
      // 재연결 직후 즉시 재등록 — 서버가 오프라인 처리했을 수 있음
      void discoverAndRegister();
    },
  });

  /** 발견 → 등록. 인플라이트 가드로 동시 실행·늦은 결과 덮어쓰기 방지 */
  async function discoverAndRegister(): Promise<void> {
    if (isDiscoveryInFlight) {
      logger.debug('발견 진행 중 — 이번 회차 생략');
      return;
    }
    isDiscoveryInFlight = true;
    try {
      const result = await discoverDevices();
      const shouldRegister = discoveryState.apply(result);
      if (!shouldRegister) return;

      const sent = tunnel.sendRegister(discoveryState.current);
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
