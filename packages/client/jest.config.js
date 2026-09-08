/**
 * Jest 설정 — ts-jest 기반 유닛 테스트 (Nest 미사용 — vm-modules 불필요).
 * 라이브러리 빌드는 @types/node를 배제(lib.dom fetch 충돌 회피)하지만,
 * 테스트는 node에서 돌므로 여기서만 node 타입을 추가 (드리프트 테스트의 fs/child_process)
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { types: ['jest', 'node'] } }],
  },
  collectCoverageFrom: ['**/*.ts', '!generated/**'],
  coverageDirectory: '../coverage',
};
