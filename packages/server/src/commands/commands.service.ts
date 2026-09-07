import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
} from '@nestjs/common';
import { COMMAND_ERROR_TIMEOUT, COMMAND_ERROR_UNSUPPORTED, DeviceAction } from '@nebula/shared';
import { AgentNotConnectedError, AgentsGateway } from '../agents/agents.gateway';
import { DevicesService } from '../devices/devices.service';

/**
 * 기기 명령 실행 — 점유자 검증 후 Agent 터널로 프록시
 * 데이터 접근은 DevicesService 경유 (모듈 소유권 분리)
 */
@Injectable()
export class CommandsService {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly agentsGateway: AgentsGateway,
  ) {}

  /** 점유자만 명령 가능 — 불일치 403, 오프라인 409, Agent 미연결 502, 응답 없음 504 */
  async execute(deviceId: string, occupantId: string, action: DeviceAction): Promise<unknown> {
    const device = this.devicesService.getById(deviceId);
    if (device.occupantId !== occupantId) {
      throw new ForbiddenException('점유자 불일치 — 점유한 기기만 조작 가능');
    }
    if (device.status !== 'online' || !device.agentId) {
      throw new ConflictException('기기 오프라인');
    }

    const outcome = await this.sendToAgent(device.agentId, deviceId, action);
    if (!outcome.ok && outcome.error === COMMAND_ERROR_UNSUPPORTED) {
      throw new BadRequestException('Agent가 지원하지 않는 액션 (Agent 업데이트 필요)');
    }
    if (!outcome.ok && outcome.error === COMMAND_ERROR_TIMEOUT) {
      throw new GatewayTimeoutException('기기 응답 시간 초과');
    }
    if (!outcome.ok) {
      throw new BadGatewayException(`기기 명령 실패: ${outcome.error}`);
    }
    return outcome.result;
  }

  private async sendToAgent(agentId: string, deviceId: string, action: DeviceAction) {
    try {
      return await this.agentsGateway.sendCommand(agentId, deviceId, action);
    } catch (error) {
      if (error instanceof AgentNotConnectedError) {
        throw new BadGatewayException('Agent 터널 미연결');
      }
      throw error;
    }
  }
}
