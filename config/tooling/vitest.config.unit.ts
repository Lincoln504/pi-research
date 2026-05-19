import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import os from 'node:os';

// Use a fraction of available CPUs for parallel forks.
// onnxruntime-node is a native NAPI addon that cannot be loaded in worker
// threads, so pool must remain 'forks'. Concurrency comes from maxForks.
const cpuCount = os.cpus().length;
const maxForks = Math.max(2, Math.min(cpuCount, 8));

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
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
