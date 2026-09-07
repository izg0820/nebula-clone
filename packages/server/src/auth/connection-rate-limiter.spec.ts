import { ConnectionRateLimiter } from './connection-rate-limiter';

describe('ConnectionRateLimiter', () => {
  test('창 내 실패 임계 미만이면 차단하지 않음', () => {
    const limiter = new ConnectionRateLimiter();
    for (let index = 0; index < 9; index += 1) limiter.recordFailure('1.2.3.4', 0);

    expect(limiter.isBlocked('1.2.3.4', 1_000)).toBe(false);
  });

  test('창 내 실패 임계 도달 시 차단, 창 경과 후 해제', () => {
    const limiter = new ConnectionRateLimiter();
    for (let index = 0; index < 10; index += 1) limiter.recordFailure('1.2.3.4', 0);

    expect(limiter.isBlocked('1.2.3.4', 30_000)).toBe(true);
    expect(limiter.isBlocked('1.2.3.4', 61_000)).toBe(false);
  });

  test('IP별 독립 집계', () => {
    const limiter = new ConnectionRateLimiter();
    for (let index = 0; index < 10; index += 1) limiter.recordFailure('1.2.3.4', 0);

    expect(limiter.isBlocked('5.6.7.8', 1_000)).toBe(false);
  });

  test('remoteAddress 미상(undefined)도 하나의 키로 집계', () => {
    const limiter = new ConnectionRateLimiter();
    for (let index = 0; index < 10; index += 1) limiter.recordFailure(undefined, 0);

    expect(limiter.isBlocked(undefined, 1_000)).toBe(true);
  });
});
