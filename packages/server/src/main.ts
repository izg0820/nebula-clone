import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DEFAULT_PORT } from './config/constants';
import { createOpenApiDocument } from './openapi/openapi.config';

/** 서버 부트스트랩 */
async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));

  // OpenAPI 스펙 (코드 우선) — /docs
  // 주의: Swagger 라우트는 Express에 직접 등록되어 전역 가드를 타지 않음
  // → 공인 IP 배포 전제라 ENABLE_DOCS=true 일 때만 노출 (기본 비활성)
  if (process.env.ENABLE_DOCS === 'true') {
    SwaggerModule.setup('docs', app, createOpenApiDocument(app));
  }

  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT) || DEFAULT_PORT);
}

// 데몬 안전망 — 조용히 좀비가 되느니 죽고 launchd(scripts/daemon.sh)가 재기동.
// 주의: 리스너를 달면 Node 기본 종료 동작이 사라지므로 반드시 직접 exit해야 함
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`처리되지 않은 Promise 거부 — 종료 (감시자가 재기동): ${String(reason)}\n`);
  process.exit(1);
});
process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`처리되지 않은 예외 — 종료 (감시자가 재기동): ${error.stack ?? error}\n`);
  process.exit(1);
});

bootstrap().catch((error: unknown) => {
  process.stderr.write(`서버 기동 실패: ${String(error)}\n`);
  process.exit(1);
});
