import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DEFAULT_PORT } from './config/constants';

/** 서버 부트스트랩 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Agent 터널용 raw ws 어댑터
  app.useWebSocketAdapter(new WsAdapter(app));

  // 경계 입력 검증 — 선언 외 필드 제거
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // OpenAPI 스펙 (코드 우선) — /docs
  // 주의: Swagger 라우트는 Express에 직접 등록되어 전역 가드를 타지 않음
  // → 공인 IP 배포 전제라 ENABLE_DOCS=true 일 때만 노출 (기본 비활성)
  if (process.env.ENABLE_DOCS === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('nebula-clone')
      .setDescription('디바이스 팜 오케스트레이션 API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT) || DEFAULT_PORT);
}

void bootstrap();
