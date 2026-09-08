/** Jest 설정 — ts-jest 기반 유닛 테스트 (Nest 미사용 — vm-modules 불필요) */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  collectCoverageFrom: ['**/*.ts', '!main.ts'],
  coverageDirectory: '../coverage',
};
