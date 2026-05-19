import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 180000,
    // Sequential file execution: browser-pool-orchestration.test.ts launches real
    // Camoufox/Chromium sessions and takes ~12 min in CI. Running it in parallel
    // with tools-connectivity (128 s) blows the job timeout budget.
    fileParallelism: false,
    pool: 'forks',
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
