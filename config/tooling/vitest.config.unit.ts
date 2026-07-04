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
    // Clear mock call history before every test so no test silently depends on
    // calls recorded by an earlier test (implementations are preserved).
    clearMocks: true,
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'forks' as const,
    maxForks,
    minForks: 2,
    // A handful of cli.test.ts cases spawn the built `dist/cli.mjs`, which loads
    // the whole bundled engine (lancedb/transformers) on startup. spawnSync is
    // synchronous, so a test's wall-clock equals the subprocess's — under a fully
    // saturated fork pool that can run several seconds. The ceiling sits above the
    // per-spawn cap (20s) so a killed subprocess fails on a clean assertion, not a
    // vitest timeout. Pure-function tests are unaffected (they finish in ms).
    testTimeout: 30000,
    hookTimeout: 120000,
    teardownTimeout: 10000,
  },
});
