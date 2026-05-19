import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 180000,
    // Each integration test file uses its own /tmp dir — files can run in parallel.
    // Tests within a single file share LanceDB instances, so they run sequentially.
    fileParallelism: true,
    pool: 'forks',
    forks: {
      maxForks: 4,
      minForks: 1,
    },
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
