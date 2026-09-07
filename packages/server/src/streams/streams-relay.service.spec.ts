import { FRAME_FORMAT_H264 } from '@nebula/shared';
import type { WebSocket } from 'ws';
import { StreamsRelayService } from './streams-relay.service';

/** 전송 기록용 목 소켓 */
class FakeViewer {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  isTerminated = false;
  sent: Uint8Array[] = [];

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  terminate(): void {
    this.isTerminated = true;
  }
}

describe('StreamsRelayService', () => {
  test('broadcast는 해당 기기의 열린 시청자에게만 전달', () => {
    const relay = new StreamsRelayService();
    const watching = new FakeViewer();
    const closed = new FakeViewer();
    closed.readyState = 3;
    const otherDevice = new FakeViewer();

    relay.addViewer('u1', watching as unknown as WebSocket);
    relay.addViewer('u1', closed as unknown as WebSocket);
    relay.addViewer('u2', otherDevice as unknown as WebSocket);

    relay.broadcast({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 644,
      height: 1398,
      stampMs: 1000,
      payload: new Uint8Array([0x00, 0x00, 0x00, 0x01]),
    });

    expect(watching.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(otherDevice.sent).toHaveLength(0);
  });

  test('퇴장한 시청자는 이후 브로드캐스트에서 제외', () => {
    const relay = new StreamsRelayService();
    const first = new FakeViewer();
    const second = new FakeViewer();
    relay.addViewer('u1', first as unknown as WebSocket);
    relay.addViewer('u1', second as unknown as WebSocket);

    relay.removeViewer('u1', first as unknown as WebSocket);
    relay.broadcast({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 644,
      height: 1398,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    });

    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
  });

  test('송신 큐가 밀린 시청자에겐 비키프레임 드롭, 키프레임은 전달', () => {
    const relay = new StreamsRelayService();
    const congested = new FakeViewer();
    congested.bufferedAmount = 3 * 1024 * 1024;
    relay.addViewer('u1', congested as unknown as WebSocket);

    const frame = {
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      width: 644,
      height: 1398,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    };
    relay.broadcast({ ...frame, isKey: false });
    expect(congested.sent).toHaveLength(0);

    relay.broadcast({ ...frame, isKey: true });
    expect(congested.sent).toHaveLength(1);
    expect(congested.isTerminated).toBe(false);
  });

  test('송신 누적이 축출 상한을 넘은 시청자는 terminate (half-open OOM 방지)', () => {
    const relay = new StreamsRelayService();
    const halfOpen = new FakeViewer();
    halfOpen.bufferedAmount = 17 * 1024 * 1024;
    relay.addViewer('u1', halfOpen as unknown as WebSocket);

    relay.broadcast({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 644,
      height: 1398,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    });

    expect(halfOpen.isTerminated).toBe(true);
    expect(halfOpen.sent).toHaveLength(0);
  });

  test('미등록 기기 removeViewer·broadcast는 무해', () => {
    const relay = new StreamsRelayService();
    const viewer = new FakeViewer();

    relay.removeViewer('unknown', viewer as unknown as WebSocket);
    expect(() =>
      relay.broadcast({
        deviceId: 'unknown',
        format: FRAME_FORMAT_H264,
        isKey: true,
        width: 1,
        height: 1,
        stampMs: 0,
        payload: new Uint8Array([0x01]),
      }),
    ).not.toThrow();
  });
});
