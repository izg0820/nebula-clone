import { StreamDemandGate } from './stream-demand-gate';

describe('StreamDemandGate', () => {
  test('스냅샷 수신 전에는 전송 허용 (수요 프로토콜 모르는 서버와의 호환)', () => {
    const gate = new StreamDemandGate();

    expect(gate.shouldSend('u1')).toBe(true);
  });

  test('스냅샷 이후에는 목록에 있는 기기만 전송', () => {
    const gate = new StreamDemandGate();

    gate.apply(['u1']);

    expect(gate.shouldSend('u1')).toBe(true);
    expect(gate.shouldSend('u2')).toBe(false);
  });

  test('빈 스냅샷은 전체 전송 중단 — 시청자 0명 상태', () => {
    const gate = new StreamDemandGate();

    gate.apply([]);

    expect(gate.shouldSend('u1')).toBe(false);
  });

  test('스냅샷은 누적이 아니라 교체 (이전 수요가 남지 않음)', () => {
    const gate = new StreamDemandGate();

    gate.apply(['u1', 'u2']);
    gate.apply(['u2']);

    expect(gate.shouldSend('u1')).toBe(false);
    expect(gate.shouldSend('u2')).toBe(true);
  });

  test('단선 리셋 후에는 스냅샷을 다시 받기 전까지 전송 허용', () => {
    const gate = new StreamDemandGate();
    gate.apply([]);

    gate.reset();

    expect(gate.shouldSend('u1')).toBe(true);
  });
});
