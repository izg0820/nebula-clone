import { pino } from 'pino';

/** Agent 전역 로거 — LOG_LEVEL 환경 변수로 조절 (기본 info) */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
});
