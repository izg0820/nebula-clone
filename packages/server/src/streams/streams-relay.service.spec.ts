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
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('시청자 0↔1 전환에서만 스트림 제어 호출, 중지는 유예 후', () => {
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
    relay.removeViewer('u1', second as unknown as WebSocket);
    // 즉시 중지 금지 — 유예(pre-warm 유지) 후에만 중지
    expect(control).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(control).toHaveBeenCalledWith('u1', false);
    expect(control).toHaveBeenCalledTimes(2);
  });

  test('유예 중 재입장하면 중지가 취소되고 캡처 유지 (새로고침 콜드 스타트 방지)', () => {
    const relay = new StreamsRelayService();
    const control = jest.fn();
    relay.setControlHandler(control);
    const viewer = new FakeViewer();

    relay.addViewer('u1', viewer as unknown as WebSocket);
    relay.removeViewer('u1', viewer as unknown as WebSocket);
    expect(relay.hasViewers('u1')).toBe(true); // 유예 중 = 스트림 유지 대상

    relay.addViewer('u1', viewer as unknown as WebSocket);
    jest.advanceTimersByTime(120_000);

    // stop(false)은 한 번도 호출되지 않아야 함
    const stopCalls = control.mock.calls.filter((call) => call[1] === false);
    expect(stopCalls).toHaveLength(0);
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

  test('devicesWithViewers는 유예 중인 기기도 포함, 유예 만료 후 제외', () => {
    const relay = new StreamsRelayService();
    relay.setControlHandler(() => undefined);
    const viewer = new FakeViewer();

    relay.addViewer('u1', viewer as unknown as WebSocket);
    expect(relay.devicesWithViewers()).toEqual(['u1']);

    relay.removeViewer('u1', viewer as unknown as WebSocket);
    expect(relay.devicesWithViewers()).toEqual(['u1']); // 유예 중 — 스트림 유지 대상

    jest.advanceTimersByTime(60_000);
    expect(relay.devicesWithViewers()).toEqual([]);
  });
});
