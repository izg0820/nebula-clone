import { loadConfig } from './config';
import { discoverDevices } from './device-discovery';
import { logger } from './logger';
import { RegisterDeviceInput } from './messages';
import { ServerTunnel } from './server-tunnel';

/** Agent 데몬 — 기기 발견 → 서버 등록 → 하트비트 반복 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.info({ agentId: config.agentId, serverUrl: config.serverUrl }, 'Agent 시작');

  let knownDevices: readonly RegisterDeviceInput[] = [];

  const tunnel = new ServerTunnel(config, {
    onOpen: () => {
      // 재연결 직후 즉시 재등록 — 서버가 오프라인 처리했을 수 있음
      void discoverAndRegister();
    },
  });

  async function discoverAndRegister(): Promise<void> {
    knownDevices = await discoverDevices();
    const sent = tunnel.sendRegister(knownDevices);
    if (sent) {
      logger.info({ count: knownDevices.length }, '기기 등록 전송');
    }
  }

  tunnel.connect();

  const discoveryTimer = setInterval(() => void discoverAndRegister(), config.discoveryIntervalMs);
  const heartbeatTimer = setInterval(() => {
    if (knownDevices.length === 0) return;
    tunnel.sendHeartbeat(knownDevices.map((device) => device.id));
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
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Agent 기동 실패');
  process.exit(1);
});
