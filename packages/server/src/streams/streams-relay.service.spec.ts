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
  closedWith: Array<{ code: number; reason: string }> = [];

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  terminate(): void {
    this.isTerminated = true;
  }

  close(code: number, reason: string): void {
    this.closedWith.push({ code, reason });
  }
}

describe('StreamsRelayService', () => {
  test('broadcast는 해당 기기의 열린 시청자에게만 전달', () => {
    const relay = new StreamsRelayService();
    const watching = new FakeViewer();
    const closed = new FakeViewer();
    closed.readyState = 3;
    const otherDevice = new FakeViewer();

    relay.addViewer('u1', 'occupant-1', watching as unknown as WebSocket);
    relay.addViewer('u1', 'occupant-1', closed as unknown as WebSocket);
    relay.addViewer('u2', 'occupant-1', otherDevice as unknown as WebSocket);

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
    relay.addViewer('u1', 'occupant-1', first as unknown as WebSocket);
    relay.addViewer('u1', 'occupant-1', second as unknown as WebSocket);

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
    relay.addViewer('u1', 'occupant-1', congested as unknown as WebSocket);

    const frame = {
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      width: 644,
      height: 1398,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    } as const;
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
    relay.addViewer('u1', 'occupant-1', halfOpen as unknown as WebSocket);

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

  test('closeViewers는 해당 세대 시청자 종료 후 목록에서 제거', () => {
    const relay = new StreamsRelayService();
    const first = new FakeViewer();
    const second = new FakeViewer();
    const alreadyClosed = new FakeViewer();
    alreadyClosed.readyState = 3;
    const otherDevice = new FakeViewer();
    relay.addViewer('u1', 'occupant-1', first as unknown as WebSocket);
    relay.addViewer('u1', 'occupant-1', second as unknown as WebSocket);
    relay.addViewer('u1', 'occupant-1', alreadyClosed as unknown as WebSocket);
    relay.addViewer('u2', 'occupant-1', otherDevice as unknown as WebSocket);

    relay.closeViewers('u1', 'occupant-1', 4408, 'occupation expired');

    expect(first.closedWith).toEqual([{ code: 4408, reason: 'occupation expired' }]);
    expect(second.closedWith).toEqual([{ code: 4408, reason: 'occupation expired' }]);
    expect(alreadyClosed.closedWith).toHaveLength(0);
    expect(otherDevice.closedWith).toHaveLength(0);

    // 제거 확인 — 이후 브로드캐스트가 도달하지 않아야 함
    relay.broadcast({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 1,
      height: 1,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    });
    expect(first.sent).toHaveLength(0);
  });

  test('closeViewers는 미등록 기기에 무해', () => {
    const relay = new StreamsRelayService();

    expect(() =>
      relay.closeViewers('unknown', 'occupant-1', 4408, 'occupation expired'),
    ).not.toThrow();
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

  test('closeViewers는 끝난 세대만 끊고 새 점유자의 시청은 유지', () => {
    const relay = new StreamsRelayService();
    const previous = new FakeViewer();
    const current = new FakeViewer();
    relay.addViewer('u1', 'occupant-A', previous as unknown as WebSocket);
    relay.addViewer('u1', 'occupant-B', current as unknown as WebSocket);

    relay.closeViewers('u1', 'occupant-A', 4408, 'occupation released');

    expect(previous.closedWith).toEqual([{ code: 4408, reason: 'occupation released' }]);
    expect(current.closedWith).toHaveLength(0);
  });

  test('세대 회수 후 프레임을 주입해도 이전 점유자에게 전달되지 않음', () => {
    const relay = new StreamsRelayService();
    const previous = new FakeViewer();
    const current = new FakeViewer();
    relay.addViewer('u1', 'occupant-A', previous as unknown as WebSocket);
    relay.closeViewers('u1', 'occupant-A', 4408, 'occupation released');
    // A의 소켓이 스스로 닫히지 않은 상태를 가정 (readyState는 OPEN 유지)
    relay.addViewer('u1', 'occupant-B', current as unknown as WebSocket);

    relay.broadcast({
      deviceId: 'u1',
      format: FRAME_FORMAT_H264,
      isKey: true,
      width: 1,
      height: 1,
      stampMs: 0,
      payload: new Uint8Array([0x01]),
    });

    expect(previous.sent).toHaveLength(0);
    expect(current.sent).toHaveLength(1);
  });
});
