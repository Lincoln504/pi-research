import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Integration tests using testcontainers
    include: ['test/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 180000, // 180 second timeout for integration tests
    maxConcurrency: 1, // Only one integration test at a time due to containers
    fileParallelism: false,
    pool: 'forks',
    hookTimeout: 60000,
  },
});
