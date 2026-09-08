import { describe, expect, test } from 'vitest';
import { streamCloseOutcome, toStreamUrl } from './ScreenView';

describe('toStreamUrl', () => {
  test('http → ws 변환 + deviceId·token·occupantId 쿼리', () => {
    const url = toStreamUrl('http://localhost:3999', 'udid-1', 'tok', 'occ-1');

    expect(url).toBe('ws://localhost:3999/stream?deviceId=udid-1&token=tok&occupantId=occ-1');
  });

  test('https는 wss로', () => {
    const url = toStreamUrl('https://nebula.example.com', 'udid-1', 'tok', 'occ-1');
    expect(url).toMatch(/^wss:\/\//);
  });

  test('잘못된 서버 주소는 null — 입력 중 throw로 앱이 죽지 않게', () => {
    expect(toStreamUrl('', 'udid-1', 'tok', 'occ-1')).toBeNull();
    expect(toStreamUrl('localhos', 'udid-1', 'tok', 'occ-1')).toBeNull();
    expect(toStreamUrl('http:/', 'udid-1', 'tok', 'occ-1')).toBeNull();
  });
});

describe('streamCloseOutcome', () => {
  test('4408(점유 만료)·4403(비점유자)은 터미널 + 세션 정리', () => {
    expect(streamCloseOutcome(4408)?.isOccupationLost).toBe(true);
    expect(streamCloseOutcome(4403)?.isOccupationLost).toBe(true);
  });

  test('4401·4429는 터미널이지만 세션은 유지', () => {
    expect(streamCloseOutcome(4401)?.isOccupationLost).toBe(false);
    expect(streamCloseOutcome(4429)?.isOccupationLost).toBe(false);
  });

  test('일반 단선(1006 등)은 null — 백오프 재연결 대상', () => {
    expect(streamCloseOutcome(1006)).toBeNull();
    expect(streamCloseOutcome(1000)).toBeNull();
  });
});
