import { FRAME_FORMAT_H264 } from '@nebula/shared';
import type { WebSocket } from 'ws';
import { StreamsRelayService } from './streams-relay.service';

/** 전송 기록용 목 소켓 */
class FakeViewer {
  readonly OPEN = 1;
  readyState = 1;
  sent: Uint8Array[] = [];

  send(payload: Uint8Array): void {
    this.sent.push(payload);
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
