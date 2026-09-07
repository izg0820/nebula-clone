import { Injectable, Logger } from '@nestjs/common';
import { encodeViewerFrame } from '@nebula/shared';
import type { WebSocket } from 'ws';

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
  private controlHandler: StreamControlHandler | null = null;

  setControlHandler(handler: StreamControlHandler): void {
    this.controlHandler = handler;
  }

  addViewer(deviceId: string, socket: WebSocket): void {
    const existing = this.viewers.get(deviceId);
    if (existing) {
      existing.add(socket);
      return;
    }
    this.viewers.set(deviceId, new Set([socket]));
    this.logger.log(`첫 시청자 — 스트림 시작 지시 (device=${deviceId})`);
    this.controlHandler?.(deviceId, true);
  }

  removeViewer(deviceId: string, socket: WebSocket): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size > 0) return;

    this.viewers.delete(deviceId);
    this.logger.log(`마지막 시청자 퇴장 — 스트림 중지 지시 (device=${deviceId})`);
    this.controlHandler?.(deviceId, false);
  }

  hasViewers(deviceId: string): boolean {
    return this.viewers.has(deviceId);
  }

  /** 시청자가 있는 기기 목록 — Agent 재연결 시 스트림 재개용 */
  devicesWithViewers(): string[] {
    return [...this.viewers.keys()];
  }

  /** Agent 프레임을 해당 기기 시청자 전원에게 전달 */
  broadcast(deviceId: string, widthPt: number, heightPt: number, jpeg: Uint8Array): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;

    const payload = encodeViewerFrame({ widthPt, heightPt, jpeg });
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(payload);
    }
  }
}
