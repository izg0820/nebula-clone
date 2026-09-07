import { CommandMessage, CommandOutcome } from '@nebula/shared';
import { ControllerClient } from './controller-client';
import { ControllerEndpointResolver } from './controller-registry';
import { logger } from './logger';

/** 기기별 대기 명령 상한 — Controller가 막힌 동안의 무한 적립 방지 */
const MAX_QUEUE_DEPTH = 5;
/**
 * 큐 대기 데드라인 — 서버 명령 타임아웃(15초)과 동일. 이보다 늦게 차례가 오면
 * 서버는 이미 실패를 응답한 뒤라, 실행하면 사용자가 실패로 인지한 입력이 뒤늦게 적용됨(유령 입력)
 */
const QUEUE_STALE_MS = 15_000;

/**
 * 서버 명령 → 해당 기기 Controller로 라우팅
 * 주소는 resolver(정적 설정 또는 수퍼바이저)가 해석, 기기별 직렬 큐로 전송
 */
export class CommandExecutor {
  private readonly clients = new Map<string, ControllerClient>();
  /** 기기별 직렬 큐 — Controller는 UI 액션을 순차 처리하므로 동시 전송은 타임아웃만 유발 */
  private readonly deviceQueues = new Map<string, Promise<unknown>>();
  /** 기기별 대기 깊이 */
  private readonly queueDepths = new Map<string, number>();

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
    const depth = this.queueDepths.get(command.deviceId) ?? 0;
    if (depth >= MAX_QUEUE_DEPTH) {
      return { ok: false, error: '명령 대기열 초과 — Controller 응답 지연, 잠시 후 재시도' };
    }

    const client = this.clientFor(baseUrl);
    const enqueuedAtMs = Date.now();
    this.queueDepths.set(command.deviceId, depth + 1);
    const previous = this.deviceQueues.get(command.deviceId) ?? Promise.resolve();
    const run = previous.then((): Promise<CommandOutcome> | CommandOutcome => {
      if (Date.now() - enqueuedAtMs > QUEUE_STALE_MS) {
        return { ok: false, error: '큐 대기 초과 — 명령 폐기 (서버 타임아웃 경과)' };
      }
      return client.execute(command.action);
    });
    // 실패해도 큐가 끊기지 않도록 정리된 꼬리만 저장
    this.deviceQueues.set(
      command.deviceId,
      run
        .catch(() => undefined)
        .finally(() => {
          const current = this.queueDepths.get(command.deviceId) ?? 1;
          this.queueDepths.set(command.deviceId, current - 1);
        }),
    );
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
