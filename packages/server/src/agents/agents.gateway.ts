import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  buildCommandMessage,
  COMMAND_ERROR_AGENT_DISCONNECTED,
  COMMAND_ERROR_TIMEOUT,
  COMMAND_ERROR_UNSUPPORTED,
  CommandOutcome,
  decodeAgentFrame,
  DEVICE_ACTION_KINDS,
  DeviceAction,
  parseAgentMessage,
} from '@nebula/shared';
import type { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import { extractBearerToken, isTokenEqual } from '../auth/token.guard';
import {
  AGENT_WS_MAX_PAYLOAD_BYTES,
  AGENT_WS_PATH,
  COMMAND_TIMEOUT_MS,
} from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { disableNagle } from '../streams/socket-tuning';
import { StreamsRelayService } from '../streams/streams-relay.service';

/** agentId 허용 형식 — 로그 인젝션·사칭 방지 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 스펙 미교환(구버전) Agent에 허용하는 액션 — 스펙 교환 도입 이전부터 있던 액션만.
 * 이후 추가되는 액션은 스펙을 교환한 Agent에만 전송 (미교환 시 타임아웃 대신 즉시 거부)
 */
const LEGACY_ACTION_KINDS: ReadonlySet<string> = new Set(
  DEVICE_ACTION_KINDS.filter((kind) => kind !== 'pressButton'),
);

/** 소켓에 부착하는 Agent 식별 정보 */
interface AgentSocket extends WebSocket {
  agentId?: string;
}

/** 응답 대기 중인 명령 — agentId로 스코프 (다른 Agent의 응답이 매칭되지 않도록) */
interface PendingCommand {
  readonly agentId: string;
  readonly resolve: (outcome: CommandOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

export class AgentNotConnectedError extends Error {
  constructor(agentId: string) {
    super(`Agent 터널 미연결: ${agentId}`);
  }
}

/**
 * Agent 아웃바운드 WS 터널 수신부
 * - 연결 시 NEBULA_AGENT_TOKEN 검증 (불일치 시 4401)
 * - register / heartbeat / commandResult 메시지 처리
 * - sendCommand: 터널로 명령 전송 후 requestId 상관으로 응답 대기 (타임아웃 시 실패 반환)
 * - 연결 종료 시 해당 Agent 기기 전체 오프라인 처리
 */
@WebSocketGateway({ path: AGENT_WS_PATH, maxPayload: AGENT_WS_MAX_PAYLOAD_BYTES })
export class AgentsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentsGateway.name);
  /** agentId → 소켓 (명령 라우팅용) */
  private readonly agentSockets = new Map<string, AgentSocket>();
  /** requestId → 응답 대기 항목 */
  private readonly pendingCommands = new Map<string, PendingCommand>();
  /** agentId → 교환된 지원 액션 스펙 (미교환 구버전은 LEGACY_ACTION_KINDS 적용) */
  private readonly agentCapabilities = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly config: ConfigService,
    private readonly devicesService: DevicesService,
    private readonly streamsRelay: StreamsRelayService,
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
    disableNagle(client);
    this.agentSockets.set(agentId, client);
    this.logger.log(`Agent 연결: ${agentId}`);

    client.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        this.handleFrame(data as Buffer);
        return;
      }
      this.handleMessage(agentId, data.toString());
    });
  }

  /** Agent가 푸시한 미러링 프레임 → 시청자 릴레이 */
  private handleFrame(data: Buffer): void {
    const frame = decodeAgentFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (!frame) {
      this.logger.warn('손상된 프레임 무시');
      return;
    }
    this.streamsRelay.broadcast(frame);
  }

  handleDisconnect(client: AgentSocket): void {
    if (!client.agentId) return;
    // 현행 소켓이 아니면(이미 대체됨) 레지스트리를 건드리지 않음
    if (this.agentSockets.get(client.agentId) !== client) return;

    this.agentSockets.delete(client.agentId);
    this.agentCapabilities.delete(client.agentId);
    this.devicesService.handleAgentDisconnect(client.agentId);
    this.failPendingCommands(client.agentId);
    this.logger.log(`Agent 연결 종료: ${client.agentId} — 소속 기기 오프라인 처리`);
  }

  /** 끊긴 Agent의 in-flight 명령을 즉시 실패 처리 — 15초 타임아웃까지 기다리지 않음 */
  private failPendingCommands(agentId: string): void {
    for (const [requestId, pending] of this.pendingCommands) {
      if (pending.agentId !== agentId) continue;
      this.pendingCommands.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: COMMAND_ERROR_AGENT_DISCONNECTED });
    }
  }

  /**
   * Agent에 기기 명령 전송 후 응답 대기
   * @throws AgentNotConnectedError 터널 미연결
   * @return 타임아웃 시 { ok: false, error: 'timeout' }
   */
  async sendCommand(
    agentId: string,
    deviceId: string,
    action: DeviceAction,
  ): Promise<CommandOutcome> {
    const socket = this.agentSockets.get(agentId);
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new AgentNotConnectedError(agentId);
    }

    // 스펙 검사 — 미지원 액션은 전송하지 않고 즉시 거부 (구버전 Agent의 15초 타임아웃 방지)
    const capabilities = this.agentCapabilities.get(agentId) ?? LEGACY_ACTION_KINDS;
    if (!capabilities.has(action.kind)) {
      return { ok: false, error: COMMAND_ERROR_UNSUPPORTED };
    }

    const requestId = randomUUID();
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        resolve({ ok: false, error: COMMAND_ERROR_TIMEOUT });
      }, COMMAND_TIMEOUT_MS);

      this.pendingCommands.set(requestId, { agentId, resolve, timer });
      socket.send(JSON.stringify(buildCommandMessage(requestId, deviceId, action)));
    });
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
        this.agentCapabilities.set(
          agentId,
          new Set(message.capabilities ?? LEGACY_ACTION_KINDS),
        );
        this.logger.log(`기기 등록 (agent=${agentId}): ${message.devices.length}대`);
        return;
      }
      if (message.type === 'heartbeat') {
        this.devicesService.recordHeartbeat(message.deviceIds, agentId);
        return;
      }
      this.resolveCommand(agentId, message.requestId, message.outcome);
    } catch (error) {
      this.logger.error(`Agent 메시지 처리 실패 (agent=${agentId})`, error as Error);
    }
  }

  /** commandResult를 대기 중인 요청에 매칭 — 발신 대상 Agent의 응답만 인정 */
  private resolveCommand(agentId: string, requestId: string, outcome: CommandOutcome): void {
    const pending = this.pendingCommands.get(requestId);
    if (!pending) {
      this.logger.warn(`대기 중이지 않은 commandResult 무시 (requestId=${requestId})`);
      return;
    }
    if (pending.agentId !== agentId) {
      this.logger.warn(`다른 Agent의 commandResult 무시 (agent=${agentId}, requestId=${requestId})`);
      return;
    }
    this.pendingCommands.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
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
