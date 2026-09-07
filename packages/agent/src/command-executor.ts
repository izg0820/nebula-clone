import { CommandMessage, CommandOutcome } from '@nebula/shared';
import { ControllerClient } from './controller-client';
import { ControllerEndpointResolver } from './controller-registry';
import { logger } from './logger';

/**
 * 서버 명령 → 해당 기기 Controller로 라우팅
 * 주소는 resolver(정적 설정 또는 수퍼바이저)가 해석, 기기별 직렬 큐로 전송
 */
export class CommandExecutor {
  private readonly clients = new Map<string, ControllerClient>();
  /** 기기별 직렬 큐 — Controller는 UI 액션을 순차 처리하므로 동시 전송은 타임아웃만 유발 */
  private readonly deviceQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly resolver: ControllerEndpointResolver,
    private readonly controllerToken: string | null = null,
  ) {}

  async execute(command: CommandMessage): Promise<CommandOutcome> {
    const baseUrl = this.resolver.resolve(command.deviceId);
    if (!baseUrl) {
      logger.warn({ deviceId: command.deviceId }, 'Controller 미등록 기기에 명령 수신');
      return { ok: false, error: `기기의 controller가 등록되지 않음: ${command.deviceId}` };
    }
    if (!this.resolver.isReady(command.deviceId)) {
      return { ok: false, error: 'controller 준비 중 (러너 기동 대기)' };
    }

    const client = this.clientFor(baseUrl);
    const previous = this.deviceQueues.get(command.deviceId) ?? Promise.resolve();
    const run = previous.then(() => client.execute(command.action));
    // 실패해도 큐가 끊기지 않도록 정리된 꼬리만 저장
    this.deviceQueues.set(command.deviceId, run.catch(() => undefined));
    return run;
  }

  private clientFor(baseUrl: string): ControllerClient {
    const existing = this.clients.get(baseUrl);
    if (existing) return existing;
    const client = new ControllerClient(baseUrl, this.controllerToken);
    this.clients.set(baseUrl, client);
    return client;
  }
}
