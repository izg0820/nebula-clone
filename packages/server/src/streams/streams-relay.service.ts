import { Injectable, Logger } from '@nestjs/common';
import { AgentFrame, encodeViewerFrame } from '@nebula/shared';
import type { WebSocket } from 'ws';

/**
 * 시청자 백프레셔 — 송신 큐가 이 이상 밀리면 비키프레임 드롭.
 * ws 송신 큐는 상한이 없어 느린 시청자(절전 탭·정체 회선) 하나가 서버 메모리를 무한히 잡음
 */
const VIEWER_BACKPRESSURE_BYTES = 2 * 1024 * 1024;
/** 이 이상 누적된 시청자는 수신 불능(half-open 등)으로 판단하고 축출 */
const VIEWER_TERMINATE_BYTES = 16 * 1024 * 1024;

/**
 * 미러링 프레임 릴레이 — 기기별 시청자 관리 + 프레임 브로드캐스트
 * 캡처는 Agent가 상시 구동(pre-warm)하므로 서버는 시작/중지에 관여하지 않음
 */
@Injectable()
export class StreamsRelayService {
  private readonly logger = new Logger(StreamsRelayService.name);
  /**
   * 기기별 시청 소켓 → 그 소켓이 연결될 때의 점유 세대(occupantId).
   * 세대를 같이 들고 있어야 점유가 끝났을 때 "그 세대의 소켓만" 정확히 회수 가능
   */
  private readonly viewers = new Map<string, Map<WebSocket, string>>();

  addViewer(deviceId: string, occupantId: string, socket: WebSocket): void {
    const existing = this.viewers.get(deviceId);
    if (existing) {
      existing.set(socket, occupantId);
      return;
    }
    this.viewers.set(deviceId, new Map([[socket, occupantId]]));
  }

  removeViewer(deviceId: string, socket: WebSocket): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size > 0) return;
    this.viewers.delete(deviceId);
  }

  /**
   * 끝난 점유 세대의 시청자 강제 종료 — 해제·유휴 만료·하트비트 회수 공통 경로.
   * 종료와 동시에 목록에서 제거하므로 이후 broadcast는 그 소켓에 닿지 않음
   */
  closeViewers(deviceId: string, occupantId: string, code: number, reason: string): void {
    const sockets = this.viewers.get(deviceId);
    if (!sockets) return;
    for (const [socket, viewerOccupantId] of sockets) {
      if (viewerOccupantId !== occupantId) continue;
      sockets.delete(socket);
      if (socket.readyState !== socket.OPEN) continue;
      socket.close(code, reason);
    }
    if (sockets.size > 0) return;
    // 뒤늦은 removeViewer는 no-op이라 안전
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
    for (const socket of sockets.keys()) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > VIEWER_TERMINATE_BYTES) {
        // half-open 소켓은 readyState가 계속 OPEN — 누적 상한으로 축출 (OOM 방지)
        this.logger.warn(
          `시청자 송신 누적 ${socket.bufferedAmount}B 초과 — 연결 축출 (device=${frame.deviceId})`,
        );
        socket.terminate();
        continue;
      }
      if (!frame.isKey && socket.bufferedAmount > VIEWER_BACKPRESSURE_BYTES) continue;
      socket.send(payload);
    }
  }
}
