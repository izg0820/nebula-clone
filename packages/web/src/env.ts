/**
 * VITE_* 주기 환경변수 해석 — 빌드 타임 주입(.env 또는 셸 env).
 * 서버 env와 달리 검증 계층이 없으므로 이상값은 조용히 기본값으로
 */
export function parseIntervalEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000) return fallback;
  return parsed;
}
