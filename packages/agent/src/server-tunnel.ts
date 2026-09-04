import WebSocket from 'ws';
import { AgentConfig } from './config';
import { logger } from './logger';
import {
  buildHeartbeatMessage,
  buildRegisterMessage,
  RegisterDeviceInput,
} from './messages';

/** 재연결 백오프 상수 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** n번째 재시도의 대기 시간 (지수 백오프 + 상한) */
export function backoffDelayMs(attempt: number): number {
  const delay = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(delay, BACKOFF_MAX_MS);
}

export interface TunnelCallbacks {
  /** 연결(재연결 포함) 성립 직후 — 즉시 재등록용 */
  readonly onOpen: () => void;
}

/**
 * 서버 아웃바운드 WS 터널 — 끊기면 지수 백오프로 자동 재연결
 * 인증은 Authorization 헤더 (쿼리스트링 노출 방지)
 */
export class ServerTunnel {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private isClosed = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly callbacks: TunnelCallbacks,
  ) {}

  connect(): void {
    if (this.isClosed) return;

    const url = `${this.config.serverUrl}?agentId=${this.config.agentId}`;
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.agentToken}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      logger.info({ url: this.config.serverUrl }, '서버 터널 연결됨');
      this.callbacks.onOpen();
    });

    socket.on('close', (code: number) => {
      logger.warn({ code }, '서버 터널 종료');
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      logger.warn({ err: error }, '서버 터널 오류');
      // close 이벤트가 뒤따르므로 재연결은 close에서만 예약
    });
  }

  sendRegister(devices: readonly RegisterDeviceInput[]): boolean {
    return this.send(JSON.stringify(buildRegisterMessage(devices)));
  }

  sendHeartbeat(deviceIds: readonly string[]): boolean {
    return this.send(JSON.stringify(buildHeartbeatMessage(deviceIds)));
  }

  /** 종료 — 재연결 중단 후 소켓 닫기 */
  close(): void {
    this.isClosed = true;
    this.socket?.close();
  }

  private send(payload: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logger.debug('터널 미연결 — 전송 생략');
      return false;
    }
    this.socket.send(payload);
    return true;
  }

  private scheduleReconnect(): void {
    if (this.isClosed) return;
    const delay = backoffDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    logger.info({ delay, attempt: this.reconnectAttempt }, '재연결 예약');
    setTimeout(() => this.connect(), delay);
  }
}
