import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';

/**
 * 실제 앱 배선 검증 — 전역 가드·ValidationPipe가 신규 라우트에 실제로 걸리는지
 * (유닛 테스트의 목 Reflector로는 잡을 수 없는 부분)
 */
describe('App e2e (실배선)', () => {
  const CLIENT_TOKEN = 'client-token-for-e2e-tests';
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NEBULA_CLIENT_TOKEN = CLIENT_TOKEN;
    process.env.NEBULA_AGENT_TOKEN = 'agent-token-for-e2e-tests';
    process.env.DB_PATH = ':memory:';

    // 정적 import는 env 설정보다 먼저 평가되어 ConfigModule 검증에 걸림 — 동적 import 필수
    const { AppModule } = (await import('./app.module')) as typeof import('./app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  test('/health는 인증 없이 200', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  test('토큰 없으면 모든 보호 라우트가 401 (신규 명령 라우트 포함)', async () => {
    await request(app.getHttpServer()).get('/devices').expect(401);
    await request(app.getHttpServer())
      .post('/devices/u1/actions/tap')
      .send({ occupantId: 'o', x: 1, y: 1 })
      .expect(401);
  });

  test('ValidationPipe가 명령 DTO를 실제로 검증 (400)', async () => {
    await request(app.getHttpServer())
      .post('/devices/u1/actions/tap')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({ occupantId: 'o', x: -5, y: 1 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/devices/u1/actions/tap')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({ x: 1, y: 1 })
      .expect(400);
  });

  test('유효 토큰 + 유효 DTO면 파이프 통과 후 도메인 검증 도달 (미존재 기기 404)', async () => {
    await request(app.getHttpServer())
      .post('/devices/없는기기/actions/tap')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({ occupantId: 'o', x: 1, y: 1 })
      .expect(404);
  });

  test('점유 시도 — 기기 없으면 409', async () => {
    await request(app.getHttpServer())
      .post('/devices/occupy')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({})
      .expect(409);
  });

  test('keepalive — 토큰 없으면 401, occupantId 누락 400, 미존재 기기 404', async () => {
    await request(app.getHttpServer())
      .post('/devices/u1/keepalive')
      .send({ occupantId: 'o' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/devices/u1/keepalive')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({})
      .expect(400);

    await request(app.getHttpServer())
      .post('/devices/없는기기/keepalive')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .send({ occupantId: 'o' })
      .expect(404);
  });
});
