import { Injectable } from '@nestjs/common';
import { AgentFrame, encodeViewerFrame } from '@nebula/shared';
import type { WebSocket } from 'ws';

/**
 * 미러링 프레임 릴레이 — 기기별 시청자 관리 + 프레임 브로드캐스트
 * 캡처는 Agent가 상시 구동(pre-warm)하므로 서버는 시작/중지에 관여하지 않음
 */
@Injectable()
export class StreamsRelayService {
  private readonly viewers = new Map<string, Set<WebSocket>>();

  addViewer(deviceId: string, socket: WebSocket): void {
    const existing = this.viewers.get(deviceId);
    if (existing) {
      existing.add(socket);
      return;
    }
    this.viewers.set(deviceId, new Set([socket]));
  }

  removeViewer(deviceId: string, socket: WebSocket): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size > 0) return;
    this.viewers.delete(deviceId);
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
