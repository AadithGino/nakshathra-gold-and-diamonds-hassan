import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/jest/**'],
    setupFiles: ['./test/setup-env.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
