import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { createOpenApiDocument } from './openapi.config';

/** ts-node(src/openapi)와 dist(dist/openapi) 어느 쪽에서 실행해도 packages/server/openapi.json */
const SPEC_PATH = resolve(__dirname, '../../openapi.json');

/**
 * OpenAPI 스펙 내보내기 — listen 없이 부트스트랩해 문서만 생성.
 * env는 실행 스크립트(package.json openapi)가 검증을 정직하게 통과하는 더미 값을 주입
 */
async function exportSpec(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = createOpenApiDocument(app);
  // 크론·SQLite 핸들 정리 — 안 하면 프로세스가 종료되지 않음
  await app.close();
  writeFileSync(SPEC_PATH, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`OpenAPI 스펙 생성: ${SPEC_PATH}\n`);
}

exportSpec().catch((error: unknown) => {
  process.stderr.write(`스펙 생성 실패: ${String(error)}\n`);
  process.exitCode = 1;
});
