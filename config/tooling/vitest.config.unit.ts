import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import os from 'node:os';

// onnxruntime-node is a native NAPI addon that cannot be loaded in worker threads.
// Pool must remain 'forks'; parallelism comes from maxForks.
const cpuCount = os.cpus().length;
const maxForks = Math.max(2, Math.min(cpuCount, 8));

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks,
        minForks: 2,
      },
    },
    testTimeout: 30000,
    hookTimeout: 15000,
    teardownTimeout: 10000,
  },
});
