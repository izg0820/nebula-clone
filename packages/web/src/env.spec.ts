import { describe, expect, test } from 'vitest';
import { parseIntervalEnv } from './env';

describe('parseIntervalEnv', () => {
  test('정상 정수는 채택', () => {
    expect(parseIntervalEnv('15000', 5_000)).toBe(15_000);
  });

  test('미설정·비정수·하한(1000) 미만은 기본값', () => {
    expect(parseIntervalEnv(undefined, 5_000)).toBe(5_000);
    expect(parseIntervalEnv('abc', 5_000)).toBe(5_000);
    expect(parseIntervalEnv('500', 5_000)).toBe(5_000);
    expect(parseIntervalEnv('1000.5', 5_000)).toBe(5_000);
  });
});
