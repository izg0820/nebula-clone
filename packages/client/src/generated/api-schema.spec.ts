import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CLI_PATH = resolve(__dirname, '../../node_modules/.bin/openapi-typescript');
const SPEC_PATH = resolve(__dirname, '../../../server/openapi.json');
const GENERATED_PATH = resolve(__dirname, 'api-schema.ts');

describe('생성 타입 드리프트', () => {
  test(
    '커밋된 api-schema.ts가 openapi.json 재생성 결과와 일치 — 어긋나면 pnpm --filter @nebula/client generate',
    () => {
      const regenerated = execFileSync(CLI_PATH, [SPEC_PATH], { encoding: 'utf8' });
      const committed = readFileSync(GENERATED_PATH, 'utf8');
      expect(committed).toBe(regenerated);
    },
    30_000,
  );
});
