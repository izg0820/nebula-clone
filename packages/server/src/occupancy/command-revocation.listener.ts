import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AgentsGateway } from '../agents/agents.gateway';
import { DevicesService } from '../devices/devices.service';
import {
  OccupancyEvents,
  OccupationEndedEvent,
} from '../devices/occupancy-events.service';

/**
 * 점유 종료 → Agent 실행 큐 무효화
 *
 * Agent는 명령에 실린 세대(occupantId)로 실행 직전 재확인하므로, 여기서 종료를 통지하면
 * 대기 중이던 이전 점유자 입력이 폐기된다. 이미 기기에서 실행 중인 작업은 취소할 수 없어
 * 응답 경로만 끊는다(그 결과가 이전 점유자에게 흘러가지 않게)
 */
@Injectable()
export class CommandRevocationListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommandRevocationListener.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly occupancyEvents: OccupancyEvents,
    private readonly devicesService: DevicesService,
    private readonly agentsGateway: AgentsGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.occupancyEvents.onEnded((event) => this.revoke(event));
  }

  onApplicationShutdown(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  private revoke(event: OccupationEndedEvent): void {
    this.agentsGateway.revokeOccupancy(event.deviceId, event.occupantId, this.agentIdOf(event));
  }

  /** 통지 대상 Agent — 오프라인이면 null (Agent가 재연결 시 세대를 비우므로 유실돼도 안전) */
  private agentIdOf(event: OccupationEndedEvent): string | null {
    try {
      return this.devicesService.getById(event.deviceId).agentId;
    } catch {
      this.logger.warn(`점유 종료 통지 대상 기기 없음 (device=${event.deviceId})`);
      return null;
    }
  }
}
