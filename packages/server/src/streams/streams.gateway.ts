import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { ConnectionRateLimiter } from '../auth/connection-rate-limiter';
import { isTokenEqual } from '../auth/token.guard';
import { STREAM_WS_PATH, VIEWER_WS_MAX_PAYLOAD_BYTES } from '../config/constants';
import { DevicesService } from '../devices/devices.service';
import { disableNagle } from './socket-tuning';
import { StreamsRelayService } from './streams-relay.service';

/** 소켓에 부착하는 구독 정보 */
interface ViewerSocket extends WebSocket {
  deviceId?: string;
}

/**
 * 미러링 시청자 WS — 브라우저가 ws://host/stream?deviceId=..&occupantId=..&token=.. 로 연결
 * - 브라우저 WS는 헤더 지정 불가 → 토큰은 쿼리 (프록시 로그 노출 여지 있음, 클라이언트 토큰 한정)
 * - 화면 관람도 점유자 전용 — 조작(occupantId)과 같은 인가 경계 적용
 */
@WebSocketGateway({ path: STREAM_WS_PATH, maxPayload: VIEWER_WS_MAX_PAYLOAD_BYTES })
export class StreamsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamsGateway.name);
  private readonly rateLimiter = new ConnectionRateLimiter();

  constructor(
    private readonly config: ConfigService,
    private readonly relay: StreamsRelayService,
    private readonly devicesService: DevicesService,
  ) {}

  handleConnection(client: ViewerSocket, request: IncomingMessage): void {
    const remoteIp = request.socket?.remoteAddress;
    if (this.rateLimiter.isBlocked(remoteIp)) {
      client.close(4429, 'rate limited');
      return;
    }

    const url = new URL(request.url ?? '', 'ws://localhost');
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('deviceId');
    const occupantId = url.searchParams.get('occupantId');
    const expected = this.config.get<string>('NEBULA_CLIENT_TOKEN');

    if (!token || !expected || !isTokenEqual(expected, token)) {
      this.rateLimiter.recordFailure(remoteIp);
      this.logger.warn(`시청자 인증 실패 — 연결 종료 (ip=${remoteIp ?? '?'})`);
      client.close(4401, 'unauthorized');
      return;
    }
    if (!deviceId || !occupantId) {
      client.close(4400, 'deviceId and occupantId required');
      return;
    }
    // 점유자만 관람 가능 — 토큰 공유 환경에서 타인의 조작 화면(로그인 등) 훔쳐보기 방지
    if (!this.isOccupant(deviceId, occupantId)) {
      this.rateLimiter.recordFailure(remoteIp);
      this.logger.warn(`점유자 아닌 스트림 접근 거부 (device=${deviceId}, ip=${remoteIp ?? '?'})`);
      client.close(4403, 'not occupant');
      return;
    }

    client.deviceId = deviceId;
    disableNagle(client);
    // 세대(occupantId)를 함께 등록 — 이 점유가 끝나면 이 소켓만 정확히 회수됨
    this.relay.addViewer(deviceId, occupantId, client);
  }

  handleDisconnect(client: ViewerSocket): void {
    if (!client.deviceId) return;
    this.relay.removeViewer(client.deviceId, client);
  }

  private isOccupant(deviceId: string, occupantId: string): boolean {
    try {
      return this.devicesService.getById(deviceId).occupantId === occupantId;
    } catch {
      return false;
    }
  }
}
