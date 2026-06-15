import { defineConfig } from 'vitest/config';
import os from 'node:os';
import baseConfig from './vitest.config.ts';

const cpuCount = os.cpus().length;
const maxForks = Math.max(2, Math.min(cpuCount, 8));

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'forks' as const,
    maxForks,
    minForks: 2,
    hookTimeout: 15000,
    teardownTimeout: 10000,
  },
});
