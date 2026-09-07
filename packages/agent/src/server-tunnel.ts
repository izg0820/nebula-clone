import WebSocket from 'ws';
import {
  AgentFrame,
  buildCommandResultMessage,
  buildHeartbeatMessage,
  buildRegisterMessage,
  CommandMessage,
  CommandOutcome,
  DEVICE_ACTION_KINDS,
  encodeAgentFrame,
  parseServerMessage,
  RegisterDeviceInput,
} from '@nebula/shared';
import { AgentConfig } from './config';
import { logger } from './logger';

/** 재연결 백오프 상수 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** 이 시간 이상 연결이 유지돼야 백오프 카운터 리셋 — 즉시 거부 연결(4401 등)의 1초 폭주 방지 */
const STABLE_RESET_MS = 30_000;

/** keepalive — NAT 유휴 타임아웃 등 조용한 단선 감지 */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * 프레임 백프레셔 — 소켓 송신 큐가 이 이상 밀리면 비키프레임 드롭.
 * 드롭 지점이 없으면 업링크 정체 시 지연이 스스로 회복되지 않고 메모리만 쌓임
 * (키프레임은 유지 — 디코더가 다음 IDR에서 재동기화)
 */
const FRAME_BACKPRESSURE_BYTES = 512 * 1024;
/** 드롭 관측 로그 주기 */
const DROP_LOG_INTERVAL = 100;

/** 재시도로 복구 불가능한 서버 close 코드 (설정·운영 오류) */
const TERMINAL_CLOSE_CODES: Record<number, string> = {
  4400: 'agentId 형식 위반',
  4401: '토큰 인증 실패',
  // 즉시 재연결하면 두 인스턴스가 서로를 1초 간격으로 축출하는 핑퐁이 됨 — 상한 간격으로만 재시도
  4409: '중복 agentId — 다른 Agent 인스턴스가 같은 ID로 접속함',
};

/** n번째 재시도의 대기 시간 (지수 백오프 + 상한) */
export function backoffDelayMs(attempt: number): number {
  const delay = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(delay, BACKOFF_MAX_MS);
}

export interface TunnelCallbacks {
  /** 연결(재연결 포함) 성립 직후 — 즉시 재등록용 */
  readonly onOpen: () => void;
  /** 서버 명령 수신 시 — 실행 결과를 반환하면 터널이 commandResult로 회신 */
  readonly onCommand?: (command: CommandMessage) => Promise<CommandOutcome>;
}

/** 테스트용 타이밍 오버라이드 */
export interface TunnelTimings {
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly stableResetMs?: number;
}

/**
 * 서버 아웃바운드 WS 터널 — 끊기면 지수 백오프로 자동 재연결
 * - 인증은 Authorization 헤더 (쿼리스트링 노출 방지)
 * - 백오프 리셋은 연결이 STABLE_RESET_MS 유지된 뒤에만 (즉시 거부 연결로는 리셋 안 됨)
 * - 주기 ping + pong 타임아웃 시 terminate로 half-open 연결 감지
 */
export class ServerTunnel {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private isClosed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableResetTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimeoutTimer: NodeJS.Timeout | null = null;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly stableResetMs: number;
  /** 백프레셔로 드롭한 프레임 누계 (관측용) */
  private droppedFrameCount = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly callbacks: TunnelCallbacks,
    timings: TunnelTimings = {},
  ) {
    this.pingIntervalMs = timings.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pongTimeoutMs = timings.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.stableResetMs = timings.stableResetMs ?? STABLE_RESET_MS;
  }

  /** 현재 재시도 카운터 (테스트·관측용) */
  get attemptCount(): number {
    return this.reconnectAttempt;
  }

  connect(): void {
    if (this.isClosed) return;

    const url = new URL(this.config.serverUrl);
    url.searchParams.set('agentId', this.config.agentId);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.agentToken}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      // 실시간 프레임 스트림용 — Nagle 병합으로 인한 배출 지연 방지
      (socket as WebSocket & { _socket?: { setNoDelay?: (v: boolean) => void } })._socket?.setNoDelay?.(true);
      logger.info({ url: this.config.serverUrl }, '서버 터널 연결됨');
      // 즉시 리셋 금지 — 서버가 곧바로 끊는 연결(4401 등)로 백오프가 풀리면 1초 폭주가 됨
      this.stableResetTimer = setTimeout(() => {
        this.reconnectAttempt = 0;
        logger.debug('연결 안정 — 백오프 카운터 리셋');
      }, this.stableResetMs);
      this.startKeepalive(socket);
      this.callbacks.onOpen();
    });

    socket.on('pong', () => {
      this.clearTimer('pongTimeoutTimer');
    });

    socket.on('message', (data: Buffer | string) => {
      void this.handleServerMessage(data.toString());
    });

    socket.on('close', (code: number) => {
      this.stopConnectionTimers();
      this.logClose(code);
      this.scheduleReconnect(code);
    });

    socket.on('error', (error: Error) => {
      logger.warn({ err: error }, '서버 터널 오류');
      // close 이벤트가 뒤따르므로 재연결은 close에서만 예약
    });
  }

  sendRegister(devices: readonly RegisterDeviceInput[]): boolean {
    // 지원 액션 스펙 교환 — 서버가 미지원 액션을 타임아웃 없이 즉시 거부할 수 있게 (혼합 버전 가드)
    return this.send(JSON.stringify(buildRegisterMessage(devices, DEVICE_ACTION_KINDS)));
  }

  sendHeartbeat(deviceIds: readonly string[]): boolean {
    return this.send(JSON.stringify(buildHeartbeatMessage(deviceIds)));
  }

  /** 미러링 프레임 푸시 (바이너리) — 업링크 정체 시 비키프레임 드롭 */
  sendFrame(frame: AgentFrame): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (!frame.isKey && this.socket.bufferedAmount > FRAME_BACKPRESSURE_BYTES) {
      this.droppedFrameCount += 1;
      if (this.droppedFrameCount % DROP_LOG_INTERVAL === 1) {
        logger.warn(
          { dropped: this.droppedFrameCount, buffered: this.socket.bufferedAmount },
          '업링크 정체 — 비키프레임 드롭 중',
        );
      }
      return false;
    }
    this.socket.send(encodeAgentFrame(frame));
    return true;
  }

  /** 종료 — 재연결·keepalive 중단 후 소켓 닫기 */
  close(): void {
    this.isClosed = true;
    this.clearTimer('reconnectTimer');
    this.stopConnectionTimers();
    this.socket?.close();
  }

  /** 서버 명령 수신 → 실행 → commandResult 회신. 예외는 실패 응답으로 변환 */
  private async handleServerMessage(raw: string): Promise<void> {
    const message = parseServerMessage(raw);
    if (!message) {
      logger.warn('잘못된 서버 메시지 무시');
      return;
    }
    if (!this.callbacks.onCommand) {
      this.send(
        JSON.stringify(
          buildCommandResultMessage(message.requestId, { ok: false, error: 'command handler 없음' }),
        ),
      );
      return;
    }

    const outcome = await this.callbacks.onCommand(message).catch((error: unknown): CommandOutcome => {
      logger.error({ err: error }, '명령 처리 중 예외');
      return { ok: false, error: '명령 처리 중 내부 오류' };
    });
    const sent = this.send(JSON.stringify(buildCommandResultMessage(message.requestId, outcome)));
    if (!sent) {
      logger.warn({ requestId: message.requestId }, '터널 미연결로 명령 응답 유실');
    }
  }

  private send(payload: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logger.debug('터널 미연결 — 전송 생략');
      return false;
    }
    this.socket.send(payload);
    return true;
  }

  /** 주기 ping — pong이 제때 안 오면 half-open으로 판단하고 강제 종료 */
  private startKeepalive(socket: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.ping();
      if (this.pongTimeoutTimer) return;
      this.pongTimeoutTimer = setTimeout(() => {
        logger.warn('pong 타임아웃 — half-open 연결로 판단, 강제 종료');
        socket.terminate();
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private scheduleReconnect(closeCode: number): void {
    if (this.isClosed) return;

    if (TERMINAL_CLOSE_CODES[closeCode]) {
      // 설정 오류는 재시도로 복구 불가 — 상한 간격으로만 재시도 (수정 후 재기동 대기)
      logger.error(
        { code: closeCode },
        `복구 불가 close (${TERMINAL_CLOSE_CODES[closeCode]}) — 설정 확인 필요, ${BACKOFF_MAX_MS}ms 간격 재시도`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), BACKOFF_MAX_MS);
      return;
    }

    const delay = backoffDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    logger.info({ delay, attempt: this.reconnectAttempt }, '재연결 예약');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private logClose(code: number): void {
    if (TERMINAL_CLOSE_CODES[code]) return;
    logger.warn({ code }, '서버 터널 종료');
  }

  /** 연결에 귀속된 타이머 정리 (안정 리셋·keepalive) */
  private stopConnectionTimers(): void {
    this.clearTimer('stableResetTimer');
    this.clearTimer('pingTimer');
    this.clearTimer('pongTimeoutTimer');
  }

  private clearTimer(
    key: 'reconnectTimer' | 'stableResetTimer' | 'pingTimer' | 'pongTimeoutTimer',
  ): void {
    const timer = this[key];
    if (!timer) return;
    clearTimeout(timer);
    this[key] = null;
  }
}
