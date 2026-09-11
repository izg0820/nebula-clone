import { OccupancyEvents, OccupationEndedEvent } from './occupancy-events.service';

const endedEvent: OccupationEndedEvent = {
  deviceId: 'udid-1',
  occupantId: 'occupant-1',
  reason: 'released',
};

describe('OccupancyEvents', () => {
  test('구독자 전원에게 종료를 전달', () => {
    const events = new OccupancyEvents();
    const first: OccupationEndedEvent[] = [];
    const second: OccupationEndedEvent[] = [];
    events.onEnded((event) => first.push(event));
    events.onEnded((event) => second.push(event));

    events.publishEnded(endedEvent);

    expect(first).toEqual([endedEvent]);
    expect(second).toEqual([endedEvent]);
  });

  test('해지 후에는 전달하지 않음', () => {
    const events = new OccupancyEvents();
    const received: OccupationEndedEvent[] = [];
    const unsubscribe = events.onEnded((event) => received.push(event));

    unsubscribe();
    events.publishEnded(endedEvent);

    expect(received).toEqual([]);
  });

  test('한 구독자가 던져도 나머지 구독자는 전달받음 (점유 종료는 되돌리지 않음)', () => {
    const events = new OccupancyEvents();
    const received: OccupationEndedEvent[] = [];
    events.onEnded(() => {
      throw new Error('구독자 오류');
    });
    events.onEnded((event) => received.push(event));

    expect(() => events.publishEnded(endedEvent)).not.toThrow();
    expect(received).toEqual([endedEvent]);
  });
});
