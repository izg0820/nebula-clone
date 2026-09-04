import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

/** 앱 공통 설정 — main 부트스트랩과 e2e 테스트가 동일 배선을 쓰도록 분리 */
export function configureApp(app: INestApplication): INestApplication {
  // Agent 터널용 raw ws 어댑터
  app.useWebSocketAdapter(new WsAdapter(app));
  // 경계 입력 검증 — 선언 외 필드 제거
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  return app;
}
