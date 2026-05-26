import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 180000,
    // Sequential file execution: browser-pool-failover.test.ts launches real
    // Camoufox/Chromium sessions. Running it in parallel with tools-connectivity
    // would blow the job timeout budget.
    fileParallelism: false,
    pool: 'forks',
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
