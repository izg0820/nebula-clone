import { describe, expect, test } from 'vitest';
import { toStreamUrl } from './ScreenView';

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
