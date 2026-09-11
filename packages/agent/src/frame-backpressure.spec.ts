import {
  decideFrameSend,
  FRAME_BACKPRESSURE_BYTES,
  FRAME_QUEUE_MAX_BYTES,
} from './frame-backpressure';

describe('decideFrameSend', () => {
  test('큐가 한산하면 키·비키프레임 모두 전송', () => {
    expect(decideFrameSend(true, 0)).toBe('send');
    expect(decideFrameSend(false, 0)).toBe('send');
  });

  test('1단계 초과 — 비키프레임만 드롭, 키프레임은 통과', () => {
    const buffered = FRAME_BACKPRESSURE_BYTES + 1;

    expect(decideFrameSend(false, buffered)).toBe('drop_backpressure');
    expect(decideFrameSend(true, buffered)).toBe('send');
  });

  test('절대 상한 초과 — 키프레임도 드롭 (제어 응답 지연 상한 보장)', () => {
    const buffered = FRAME_QUEUE_MAX_BYTES + 1;

    expect(decideFrameSend(true, buffered)).toBe('drop_queue_full');
    expect(decideFrameSend(false, buffered)).toBe('drop_queue_full');
  });

  test('경계값은 드롭하지 않음 (초과일 때만)', () => {
    expect(decideFrameSend(false, FRAME_BACKPRESSURE_BYTES)).toBe('send');
    expect(decideFrameSend(true, FRAME_QUEUE_MAX_BYTES)).toBe('send');
  });

  test('절대 상한은 1단계보다 커야 정책이 성립', () => {
    expect(FRAME_QUEUE_MAX_BYTES).toBeGreaterThan(FRAME_BACKPRESSURE_BYTES);
  });
});
