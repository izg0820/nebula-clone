/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // @nebula/{shared,client}는 CJS 빌드 + 워크스페이스 링크 — 사전 번들링에 명시해야 named import 동작
  optimizeDeps: { include: ['@nebula/shared', '@nebula/client'] },
  build: {
    commonjsOptions: { include: [/@nebula\/shared/, /@nebula\/client/, /node_modules/] },
  },
  test: {
    // 컴포넌트 테스트용 DOM 환경 + .tsx 스펙 수집 (기존 node/.ts 한정은 컴포넌트 테스트가 수집 불가)
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    // vitest는 optimizeDeps 사전 번들링을 안 타는 경로가 있음 — CJS 워크스페이스 패키지 인라인 필수
    server: { deps: { inline: ['@nebula/client', '@nebula/shared'] } },
  },
});
