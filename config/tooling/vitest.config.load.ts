import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import os from 'node:os';

// Load tests require more timeout and resources than unit tests
const cpuCount = os.cpus().length;
const maxForks = Math.max(2, Math.min(cpuCount, 4)); // Fewer forks for load tests

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/load/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'forks',
    forks: {
      maxForks,
      minForks: 1,
    },
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 30000,
    teardownTimeout: 30000,
  },
});