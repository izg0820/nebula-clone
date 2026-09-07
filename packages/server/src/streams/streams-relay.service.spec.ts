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
  test('시청자 0↔1 전환에서만 스트림 제어 호출', () => {
    const relay = new StreamsRelayService();
    const control = jest.fn();
    relay.setControlHandler(control);
    const first = new FakeViewer();
    const second = new FakeViewer();

    relay.addViewer('u1', first as unknown as WebSocket);
    relay.addViewer('u1', second as unknown as WebSocket);
    expect(control).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledWith('u1', true);

    relay.removeViewer('u1', first as unknown as WebSocket);
    expect(control).toHaveBeenCalledTimes(1);

    relay.removeViewer('u1', second as unknown as WebSocket);
    expect(control).toHaveBeenCalledWith('u1', false);
    expect(control).toHaveBeenCalledTimes(2);
  });

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
      format: 1,
      isKey: true,
      width: 430,
      height: 932,
      payload: new Uint8Array([0xff, 0xd8]),
    });

    expect(watching.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(otherDevice.sent).toHaveLength(0);
  });

  test('devicesWithViewers는 시청자 있는 기기만 반환', () => {
    const relay = new StreamsRelayService();
    const viewer = new FakeViewer();

    relay.addViewer('u1', viewer as unknown as WebSocket);
    expect(relay.devicesWithViewers()).toEqual(['u1']);

    relay.removeViewer('u1', viewer as unknown as WebSocket);
    expect(relay.devicesWithViewers()).toEqual([]);
  });
});
