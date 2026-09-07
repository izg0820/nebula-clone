import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { isTokenEqual } from '../auth/token.guard';
import { STREAM_WS_PATH, VIEWER_WS_MAX_PAYLOAD_BYTES } from '../config/constants';
import { StreamsRelayService } from './streams-relay.service';

/** 소켓에 부착하는 구독 정보 */
interface ViewerSocket extends WebSocket {
  deviceId?: string;
}

/**
 * 미러링 시청자 WS — 브라우저가 ws://host/stream?deviceId=..&token=.. 로 연결
 * 브라우저 WS는 헤더 지정 불가 → 토큰은 쿼리 (프록시 로그 노출 여지 있음, 클라이언트 토큰 한정)
 */
@WebSocketGateway({ path: STREAM_WS_PATH, maxPayload: VIEWER_WS_MAX_PAYLOAD_BYTES })
export class StreamsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamsGateway.name);

  constructor(
    private readonly config: ConfigService,
    private readonly relay: StreamsRelayService,
  ) {}

  handleConnection(client: ViewerSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '', 'ws://localhost');
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('deviceId');
    const expected = this.config.get<string>('NEBULA_CLIENT_TOKEN');

    if (!token || !expected || !isTokenEqual(expected, token)) {
      this.logger.warn('시청자 인증 실패 — 연결 종료');
      client.close(4401, 'unauthorized');
      return;
    }
    if (!deviceId) {
      client.close(4400, 'deviceId required');
      return;
    }

    client.deviceId = deviceId;
    this.relay.addViewer(deviceId, client);
  }

  handleDisconnect(client: ViewerSocket): void {
    if (!client.deviceId) return;
    this.relay.removeViewer(client.deviceId, client);
  }
}
