import { Injectable, Logger } from '@nestjs/common';
import { AgentFrame, encodeViewerFrame } from '@nebula/shared';
import type { WebSocket } from 'ws';
import { STREAM_LINGER_MS } from '../config/constants';

/** 스트림 시작/중지 지시 수신자 — AgentsGateway가 등록 (모듈 순환 의존 회피) */
export type StreamControlHandler = (deviceId: string, shouldStart: boolean) => void;

/**
 * 미러링 프레임 릴레이 — 기기별 시청자 관리 + 프레임 브로드캐스트
 * 시청자 0↔1 전환 시에만 Agent에 스트림 시작/중지 지시 (불필요한 기기 캡처 방지)
 */
@Injectable()
export class StreamsRelayService {
  private readonly logger = new Logger(StreamsRelayService.name);
  private readonly viewers = new Map<string, Set<WebSocket>>();
  /** 마지막 시청자 퇴장 후 유예 중인 중지 타이머 — 재입장 시 취소 (pre-warm 유지) */
  private readonly lingerTimers = new Map<string, NodeJS.Timeout>();
  private controlHandler: StreamControlHandler | null = null;

  setControlHandler(handler: StreamControlHandler): void {
    this.controlHandler = handler;
  }

  addViewer(deviceId: string, socket: WebSocket): void {
    // 유예 중 재입장 — 캡처가 살아있으므로 중지 취소만 하면 즉시 프레임 수신
    const lingerTimer = this.lingerTimers.get(deviceId);
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      this.lingerTimers.delete(deviceId);
    }

    const existing = this.viewers.get(deviceId);
    if (existing) {
      existing.add(socket);
      return;
    }
    this.viewers.set(deviceId, new Set([socket]));
    if (!lingerTimer) {
      this.logger.log(`첫 시청자 — 스트림 시작 지시 (device=${deviceId})`);
    }
    // Agent 쪽 start는 멱등 — 유예 재입장이어도 재전송 무해
    this.controlHandler?.(deviceId, true);
  }

  removeViewer(deviceId: string, socket: WebSocket): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size > 0) return;

    this.viewers.delete(deviceId);
    // 즉시 중지하지 않고 유예 — 새로고침·재마운트로 인한 콜드 스타트 방지
    const timer = setTimeout(() => {
      this.lingerTimers.delete(deviceId);
      this.logger.log(`유예 만료 — 스트림 중지 지시 (device=${deviceId})`);
      this.controlHandler?.(deviceId, false);
    }, STREAM_LINGER_MS);
    this.lingerTimers.set(deviceId, timer);
  }

  hasViewers(deviceId: string): boolean {
    return this.viewers.has(deviceId) || this.lingerTimers.has(deviceId);
  }

  /** 스트림이 살아있어야 하는 기기 목록 (유예 중 포함) — Agent 재연결 시 재개용 */
  devicesWithViewers(): string[] {
    return [...new Set([...this.viewers.keys(), ...this.lingerTimers.keys()])];
  }

  /** Agent 프레임을 해당 기기 시청자 전원에게 전달 */
  broadcast(frame: AgentFrame): void {
    const sockets = this.viewers.get(frame.deviceId);
    if (!sockets) return;

    const payload = encodeViewerFrame({
      format: frame.format,
      isKey: frame.isKey,
      width: frame.width,
      height: frame.height,
      stampMs: frame.stampMs,
      payload: frame.payload,
    });
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(payload);
    }
  }
}
