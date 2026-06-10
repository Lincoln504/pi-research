/**
 * Root vitest config — runs unit tests only.
 *
 * Integration tests require their own configs for proper isolation:
 *   npm run test:integration          (runs both groups)
 *   npm run test:integration:serial   (browser-pool tests, one file at a time)
 *   npm run test:integration:parallel (knowledge tests, concurrent)
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './config/tooling/vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: [
      ...(Array.isArray(baseConfig.test.exclude) ? baseConfig.test.exclude : []),
      'test/integration',
    ],
  },
});
