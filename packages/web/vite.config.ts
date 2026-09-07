/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // @nebula/shared는 CJS 빌드 + 워크스페이스 링크 — 사전 번들링에 명시해야 named import 동작
  optimizeDeps: { include: ['@nebula/shared'] },
  build: {
    commonjsOptions: { include: [/@nebula\/shared/, /node_modules/] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
