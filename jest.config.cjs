/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/jest'],
  testMatch: ['**/*.test.ts'],
  resolver: '<rootDir>/test/jest/resolver.cjs',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'Node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          isolatedModules: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  setupFiles: ['<rootDir>/test/jest/setup-env.cjs'],
  setupFilesAfterEnv: ['<rootDir>/test/jest/setup-after-env.ts'],
  globalSetup: '<rootDir>/test/jest/global-setup.cjs',
  globalTeardown: '<rootDir>/test/jest/global-teardown.cjs',
  testTimeout: 120_000,
  maxWorkers: 1,
  forceExit: true,
};
