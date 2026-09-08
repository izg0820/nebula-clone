import { readFileSync } from 'fs';
import { resolve } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import { configureApp } from '../app.setup';

/**
 * OpenAPI 스펙 회귀 테스트 — 생성 클라이언트의 품질을 지키는 관문:
 * ① 모든 2xx 응답이 스키마($ref)를 가짐 (빈 스키마 = 생성 타입 any 재발 차단)
 * ② occupantId 은닉 불변식이 스펙까지 전파됨
 * ③ 커밋된 openapi.json과 현재 코드가 일치 (드리프트 강제)
 */
describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    process.env.NEBULA_CLIENT_TOKEN = 'client-token-for-openapi-spec';
    process.env.NEBULA_AGENT_TOKEN = 'agent-token-for-openapi-spec';
    process.env.DB_PATH = ':memory:';

    // 정적 import는 env 설정보다 먼저 평가되어 ConfigModule 검증에 걸림 — 동적 import 필수
    const { AppModule } = (await import('../app.module')) as typeof import('../app.module');
    const { createOpenApiDocument } = (await import(
      './openapi.config'
    )) as typeof import('./openapi.config');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // configureApp 필수 — WsAdapter 없이는 게이트웨이 초기화가 실패함
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    document = createOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  function schemas(): Record<string, { properties?: Record<string, unknown>; required?: string[] }> {
    return (document.components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
  }

  test('모든 2xx 응답에 JSON 스키마 존재 (빈 응답 스키마 = 생성 타입 any 재발)', () => {
    const paths = document.paths;
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(12);

    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations as Record<string, unknown>)) {
        const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
        const success = Object.entries(responses).filter(([status]) => status.startsWith('2'));
        expect(success.length).toBeGreaterThan(0);
        for (const [status, response] of success) {
          const content = (response as { content?: Record<string, { schema?: unknown }> })
            .content;
          const schema = content?.['application/json']?.schema as
            | { $ref?: string; type?: string; items?: { $ref?: string } }
            | undefined;
          const hasRef = Boolean(schema?.$ref ?? schema?.items?.$ref);
          if (!hasRef) {
            throw new Error(`${method.toUpperCase()} ${path} ${status} 응답에 스키마 없음`);
          }
        }
      }
    }
  });

  test('PublicDeviceDto에 occupantId 없음 + isOccupied 필수 (은닉 불변식의 스펙 전파)', () => {
    const publicDevice = schemas().PublicDeviceDto;
    expect(publicDevice).toBeDefined();
    expect(Object.keys(publicDevice.properties ?? {})).not.toContain('occupantId');
    expect(publicDevice.required).toContain('isOccupied');
    expect(publicDevice.required).toContain('lastActivityAt');
  });

  test('occupantId는 OccupyResponseDto에만 존재', () => {
    const all = schemas();
    const holders = Object.entries(all)
      .filter(([, schema]) => Object.keys(schema.properties ?? {}).includes('occupantId'))
      .map(([name]) => name);
    // 요청 DTO(제출용)는 허용 — 응답 스키마 중에서는 OccupyResponseDto만
    const responseHolders = holders.filter((name) => name.endsWith('ResponseDto'));
    expect(responseHolders).toEqual(['OccupyResponseDto']);
  });

  test('screenshot·ui-dump 응답의 중첩 result 스키마가 실제 필드를 선언', () => {
    const screenshot = schemas().ScreenshotResultDto;
    expect(Object.keys(screenshot.properties ?? {})).toEqual(
      expect.arrayContaining(['ok', 'jpegBase64', 'widthPt', 'heightPt']),
    );
    const uiDump = schemas().UiDumpResultDto;
    expect(Object.keys(uiDump.properties ?? {})).toEqual(expect.arrayContaining(['ok', 'tree']));
  });

  test('/health는 무인증, /devices는 bearer 요구로 문서화됨', () => {
    const health = document.paths['/health']?.get as { security?: unknown[] };
    expect(health.security ?? []).toHaveLength(0);
    const devices = document.paths['/devices']?.get as { security?: unknown[] };
    expect(devices.security?.length).toBeGreaterThan(0);
  });

  test('커밋된 openapi.json과 현재 코드가 일치 — 어긋나면 pnpm --filter @nebula/server openapi 재실행', () => {
    const committed = JSON.parse(
      readFileSync(resolve(__dirname, '../../openapi.json'), 'utf8'),
    ) as OpenAPIObject;
    // 문자열 비교가 아닌 객체 비교 — 포맷 흔들림에 취약해지지 않게
    expect(JSON.parse(JSON.stringify(document))).toEqual(committed);
  });
});
