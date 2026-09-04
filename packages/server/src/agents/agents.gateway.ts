import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import { extractBearerToken, isTokenEqual } from '../auth/token.guard';
import { AGENT_WS_PATH } from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { parseAgentMessage } from './agent-messages';

/** agentId 허용 형식 — 로그 인젝션·사칭 방지 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 소켓에 부착하는 Agent 식별 정보 */
interface AgentSocket extends WebSocket {
  agentId?: string;
}

/**
 * Agent 아웃바운드 WS 터널 수신부
 * - 연결 시 NEBULA_AGENT_TOKEN 검증 (불일치 시 즉시 종료)
 * - register / heartbeat 메시지로 레지스트리 갱신
 * - 연결 종료 시 해당 Agent 기기 전체 오프라인 처리
 * - Phase 2에서 이 터널로 기기 명령 라우팅 예정
 */
@WebSocketGateway({ path: AGENT_WS_PATH })
export class AgentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentsGateway.name);
  /** agentId → 소켓 (Phase 2 명령 라우팅용) */
  private readonly agentSockets = new Map<string, AgentSocket>();

  constructor(
    private readonly config: ConfigService,
    private readonly devicesService: DevicesService,
  ) {}

  handleConnection(client: AgentSocket, request: IncomingMessage): void {
    if (!this.isAuthorized(request)) {
      this.logger.warn('Agent 인증 실패 — 연결 종료');
      client.close(4401, 'unauthorized');
      return;
    }

    const agentId = this.resolveAgentId(request);
    if (!agentId) {
      this.logger.warn('잘못된 agentId 형식 — 연결 종료');
      client.close(4400, 'invalid agentId');
      return;
    }

    // 동일 agentId 재연결 시 기존 소켓 대체 — 늦게 오는 옛 소켓의 close가
    // 새 연결의 기기를 오프라인 처리하지 않도록 맵 기준으로 현행 소켓 판별
    const existing = this.agentSockets.get(agentId);
    if (existing && existing !== client) {
      this.logger.warn(`Agent 중복 연결 (${agentId}) — 기존 소켓 대체`);
      existing.close(4409, 'superseded');
    }

    client.agentId = agentId;
    this.agentSockets.set(agentId, client);
    this.logger.log(`Agent 연결: ${agentId}`);

    client.on('message', (data: Buffer | string) => {
      this.handleMessage(agentId, data.toString());
    });
  }

  handleDisconnect(client: AgentSocket): void {
    if (!client.agentId) return;
    // 현행 소켓이 아니면(이미 대체됨) 레지스트리를 건드리지 않음
    if (this.agentSockets.get(client.agentId) !== client) return;

    this.agentSockets.delete(client.agentId);
    this.devicesService.handleAgentDisconnect(client.agentId);
    this.logger.log(`Agent 연결 종료: ${client.agentId} — 소속 기기 오프라인 처리`);
  }

  /** 수신 메시지 처리 — 예외가 프로세스를 죽이지 않도록 격리 */
  private handleMessage(agentId: string, raw: string): void {
    try {
      const message = parseAgentMessage(raw);
      if (!message) {
        this.logger.warn(`잘못된 Agent 메시지 무시 (agent=${agentId})`);
        return;
      }

      if (message.type === 'register') {
        this.devicesService.registerFromAgent(message.devices, agentId);
        this.logger.log(`기기 등록 (agent=${agentId}): ${message.devices.length}대`);
        return;
      }
      this.devicesService.recordHeartbeat(message.deviceIds, agentId);
    } catch (error) {
      this.logger.error(`Agent 메시지 처리 실패 (agent=${agentId})`, error as Error);
    }
  }

  /** 연결 요청 토큰 검증 — Authorization 헤더 또는 ?token= 쿼리 */
  private isAuthorized(request: IncomingMessage): boolean {
    const expected = this.config.get<string>('NEBULA_AGENT_TOKEN');
    if (!expected) return false;

    const headerToken = extractBearerToken(request.headers.authorization);
    const queryToken = new URL(request.url ?? '', 'ws://localhost').searchParams.get('token');
    const token = headerToken ?? queryToken;
    return token !== null && isTokenEqual(expected, token);
  }

  /** ?agentId= 쿼리 우선(형식 검증), 없으면 발급 — 형식 불일치 시 null */
  private resolveAgentId(request: IncomingMessage): string | null {
    const queryAgentId = new URL(request.url ?? '', 'ws://localhost').searchParams.get('agentId');
    if (queryAgentId === null) return `agent-${randomUUID()}`;
    if (AGENT_ID_PATTERN.test(queryAgentId)) return queryAgentId;
    return null;
  }
}
