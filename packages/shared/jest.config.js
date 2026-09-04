/** Jest 설정 — ts-jest 기반 유닛 테스트 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  collectCoverageFrom: ['**/*.ts'],
  coverageDirectory: '../coverage',
};
