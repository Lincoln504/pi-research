import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // NOTE: No real integration tests yet. Future tests should use testcontainers
    // to test actual integration with external services (SearXNG, NVD, OSV, etc.)
    include: [],
    setupFiles: [],
    testTimeout: 120000,
    maxConcurrency: 2,
  },
});