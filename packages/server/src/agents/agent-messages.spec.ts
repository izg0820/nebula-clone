import { parseAgentMessage } from './agent-messages';

describe('parseAgentMessage', () => {
  test('register 메시지 파싱', () => {
    const raw = JSON.stringify({
      type: 'register',
      devices: [
        { id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: ['smoke'] },
      ],
    });

    const message = parseAgentMessage(raw);

    expect(message).toEqual({
      type: 'register',
      devices: [
        { id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: ['smoke'] },
      ],
    });
  });

  test('heartbeat 메시지 파싱', () => {
    const message = parseAgentMessage(JSON.stringify({ type: 'heartbeat', deviceIds: ['udid-1'] }));
    expect(message).toEqual({ type: 'heartbeat', deviceIds: ['udid-1'] });
  });

  test('잘못된 JSON·형식은 null', () => {
    expect(parseAgentMessage('not-json')).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: 'heartbeat', deviceIds: [1] }))).toBeNull();
    expect(
      parseAgentMessage(
        JSON.stringify({ type: 'register', devices: [{ id: 1, platform: 'android' }] }),
      ),
    ).toBeNull();
  });
});
