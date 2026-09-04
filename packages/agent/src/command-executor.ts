import { CommandMessage, CommandOutcome } from '@nebula/shared';
import { ControllerClient } from './controller-client';
import { logger } from './logger';

/**
 * 서버 명령 → 해당 기기 Controller로 라우팅
 * 기기별 Controller 주소는 현재 정적 설정 (NEBULA_CONTROLLER_PORTS)
 * TODO Phase 2 후반: xcodebuild 수퍼바이저가 동적으로 등록
 */
export class CommandExecutor {
  private readonly clients = new Map<string, ControllerClient>();
  /** 기기별 직렬 큐 — Controller는 UI 액션을 순차 처리하므로 동시 전송은 타임아웃만 유발 */
  private readonly deviceQueues = new Map<string, Promise<unknown>>();

  constructor(controllerPorts: ReadonlyMap<string, number>) {
    for (const [deviceId, port] of controllerPorts) {
      this.clients.set(deviceId, new ControllerClient(`http://127.0.0.1:${port}`));
    }
  }

  async execute(command: CommandMessage): Promise<CommandOutcome> {
    const client = this.clients.get(command.deviceId);
    if (!client) {
      logger.warn({ deviceId: command.deviceId }, 'Controller 미등록 기기에 명령 수신');
      return { ok: false, error: `기기의 controller가 등록되지 않음: ${command.deviceId}` };
    }

    const previous = this.deviceQueues.get(command.deviceId) ?? Promise.resolve();
    const run = previous.then(() => client.execute(command.action));
    // 실패해도 큐가 끊기지 않도록 정리된 꼬리만 저장
    this.deviceQueues.set(command.deviceId, run.catch(() => undefined));
    return run;
  }
}
