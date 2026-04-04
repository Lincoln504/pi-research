import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup/integration.ts'],
    testTimeout: 120000,
    maxConcurrency: 2,
  },
});
