import type { Socket } from 'net';
import type { WebSocket } from 'ws';

/**
 * 실시간 스트림용 소켓 튜닝 — Nagle 비활성화
 * 소프레임(3~8KB)이 40fps로 흐를 때 Nagle 병합이 배출 지연·스터터를 유발함
 */
export function disableNagle(socket: WebSocket): void {
  const raw = (socket as WebSocket & { _socket?: Socket })._socket;
  raw?.setNoDelay(true);
}
