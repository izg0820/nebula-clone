/** 인증 실패 집계 창 */
const WINDOW_MS = 60_000;
/** 창 내 허용 실패 횟수 — 초과 IP는 창이 끝날 때까지 즉시 거부 */
const MAX_FAILURES_PER_WINDOW = 10;
/** 항목 정리 임계 — 맵 무한 증가 방지 */
const CLEANUP_THRESHOLD = 1_000;

interface FailureWindow {
  count: number;
  windowStartMs: number;
}

/**
 * WS 핸드셰이크 인증 실패 rate limit — HTTP ThrottlerGuard가 커버하지 못하는
 * 게이트웨이 연결 경로의 무차별 토큰 대입 완화 (IP 단위 고정 창)
 */
export class ConnectionRateLimiter {
  private readonly failures = new Map<string, FailureWindow>();

  /** 이 IP의 연결 시도를 거부해야 하는지 (창 내 실패 초과) */
  isBlocked(ip: string | undefined, nowMs: number = Date.now()): boolean {
    const entry = this.failures.get(this.toKey(ip));
    if (!entry) return false;
    if (nowMs - entry.windowStartMs >= WINDOW_MS) return false;
    return entry.count >= MAX_FAILURES_PER_WINDOW;
  }

  /** 인증 실패 기록 */
  recordFailure(ip: string | undefined, nowMs: number = Date.now()): void {
    this.cleanupIfNeeded(nowMs);
    const key = this.toKey(ip);
    const entry = this.failures.get(key);
    if (!entry || nowMs - entry.windowStartMs >= WINDOW_MS) {
      this.failures.set(key, { count: 1, windowStartMs: nowMs });
      return;
    }
    entry.count += 1;
  }

  private toKey(ip: string | undefined): string {
    return ip ?? 'unknown';
  }

  private cleanupIfNeeded(nowMs: number): void {
    if (this.failures.size < CLEANUP_THRESHOLD) return;
    for (const [key, entry] of this.failures) {
      if (nowMs - entry.windowStartMs >= WINDOW_MS) this.failures.delete(key);
    }
  }
}
