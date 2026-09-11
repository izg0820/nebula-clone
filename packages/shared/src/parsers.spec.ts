import { parseAgentMessage, parseServerMessage } from './parsers';

describe('parseAgentMessage', () => {
  test('register 메시지 파싱', () => {
    const raw = JSON.stringify({
      type: 'register',
      devices: [
        { id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: ['smoke'] },
      ],
    });

    expect(parseAgentMessage(raw)).toEqual({
      type: 'register',
      devices: [
        { id: 'udid-1', name: 'iPhone', platform: 'ios', osVersion: '17.5', tags: ['smoke'] },
      ],
    });
  });

  test('android platform 통과, 알 수 없는 platform은 register 폐기', () => {
    const androidRaw = JSON.stringify({
      type: 'register',
      devices: [{ id: 'R3CX90', name: 'SM F966N', platform: 'android', osVersion: '17', tags: [] }],
    });
    expect(parseAgentMessage(androidRaw)).toMatchObject({ type: 'register' });

    const unknownRaw = JSON.stringify({
      type: 'register',
      devices: [{ id: 'x1', name: 'n', platform: 'windows', osVersion: '11', tags: [] }],
    });
    expect(parseAgentMessage(unknownRaw)).toBeNull();
  });

  test('pressButton back 통과, 알 수 없는 버튼은 command 폐기', () => {
    const command = (button: string) =>
      JSON.stringify({
        type: 'command',
        requestId: 'req-1',
        deviceId: 'u1',
        occupantId: 'occupant-1',
        action: { kind: 'pressButton', button },
      });

    expect(parseServerMessage(command('back'))).toMatchObject({
      action: { kind: 'pressButton', button: 'back' },
    });
    expect(parseServerMessage(command('power'))).toBeNull();
  });

  test('register capabilities — 유효 광고는 보존, 손상은 null, 미광고는 undefined', () => {
    const base = {
      type: 'register',
      devices: [{ id: 'u1', name: 'n', platform: 'ios', osVersion: '17', tags: [] }],
    };

    const advertised = parseAgentMessage(
      JSON.stringify({ ...base, capabilities: ['tap', 'pressButton'] }),
    );
    expect(advertised).toMatchObject({ capabilities: ['tap', 'pressButton'] });

    const legacy = parseAgentMessage(JSON.stringify(base));
    expect(legacy && 'capabilities' in legacy && legacy.capabilities).toBeFalsy();

    expect(parseAgentMessage(JSON.stringify({ ...base, capabilities: [1] }))).toBeNull();
  });

  test('heartbeat 메시지 파싱', () => {
    expect(parseAgentMessage(JSON.stringify({ type: 'heartbeat', deviceIds: ['u1'] }))).toEqual({
      type: 'heartbeat',
      deviceIds: ['u1'],
    });
  });

  test('commandResult 메시지 파싱 (성공·실패)', () => {
    expect(
      parseAgentMessage(
        JSON.stringify({ type: 'commandResult', requestId: 'r1', outcome: { ok: true, result: 1 } }),
      ),
    ).toEqual({ type: 'commandResult', requestId: 'r1', outcome: { ok: true, result: 1 } });

    expect(
      parseAgentMessage(
        JSON.stringify({ type: 'commandResult', requestId: 'r1', outcome: { ok: false, error: 'x' } }),
      ),
    ).toEqual({ type: 'commandResult', requestId: 'r1', outcome: { ok: false, error: 'x' } });
  });

  test('잘못된 JSON·형식은 null', () => {
    expect(parseAgentMessage('not-json')).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: 'heartbeat', deviceIds: [1] }))).toBeNull();
    expect(
      parseAgentMessage(JSON.stringify({ type: 'register', devices: [{ id: 1 }] })),
    ).toBeNull();
    expect(
      parseAgentMessage(JSON.stringify({ type: 'commandResult', requestId: 'r1', outcome: { ok: false } })),
    ).toBeNull();
  });
});

describe('parseServerMessage', () => {
  test('command 메시지 파싱 — 액션 종류별', () => {
    const base = { type: 'command', requestId: 'r1', deviceId: 'u1', occupantId: 'occupant-1' };

    expect(
      parseServerMessage(JSON.stringify({ ...base, action: { kind: 'tap', x: 10, y: 20 } })),
    ).toEqual({ ...base, action: { kind: 'tap', x: 10, y: 20 } });

    expect(
      parseServerMessage(
        JSON.stringify({
          ...base,
          action: { kind: 'swipe', fromX: 0, fromY: 0, toX: 100, toY: 200, durationMs: 300 },
        }),
      ),
    ).not.toBeNull();

    expect(
      parseServerMessage(JSON.stringify({ ...base, action: { kind: 'typeText', text: '안녕' } })),
    ).not.toBeNull();

    expect(parseServerMessage(JSON.stringify({ ...base, action: { kind: 'uiDump' } }))).not.toBeNull();

    expect(
      parseServerMessage(JSON.stringify({ ...base, action: { kind: 'screenshot' } })),
    ).not.toBeNull();
  });

  test('필드 누락·비유한 좌표는 null', () => {
    const base = { type: 'command', requestId: 'r1', deviceId: 'u1', occupantId: 'occupant-1' };

    expect(parseServerMessage(JSON.stringify({ ...base, action: { kind: 'tap', x: 10 } }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...base, action: { kind: 'tap', x: 'a', y: 2 } })),
    ).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'command', action: null }))).toBeNull();
    expect(parseServerMessage('broken')).toBeNull();
  });

  test('occupantId 누락·형식 위반 command는 폐기 (세대 없는 명령은 실행 금지)', () => {
    const action = { kind: 'uiDump' };
    const withoutOccupant = { type: 'command', requestId: 'r1', deviceId: 'u1', action };

    expect(parseServerMessage(JSON.stringify(withoutOccupant))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...withoutOccupant, occupantId: '경로/삽입' })),
    ).toBeNull();
  });

  test('occupancyEnded 파싱 — deviceId·occupantId 형식 검증', () => {
    const ended = { type: 'occupancyEnded', deviceId: 'u1', occupantId: 'occupant-1' };

    expect(parseServerMessage(JSON.stringify(ended))).toEqual(ended);
    expect(parseServerMessage(JSON.stringify({ type: 'occupancyEnded', deviceId: 'u1' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...ended, deviceId: '../etc' }))).toBeNull();
  });
});
