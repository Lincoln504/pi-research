import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Base Vitest configuration.
 *
 * This file is extended by all test group configs (unit, integration-parallel,
 * integration-serial). It provides shared defaults only — each child config
 * supplies its own `include`, `setupFiles`, timeouts, and parallelism settings.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // No default include — each child config specifies its own test paths.
    // Prevents accidentally running the wrong group without correct pool settings.
    include: [],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
        'test/',
      ],
      reportOnFailure: true,
    },

    // Verbose reporters show skipped test names alongside results.
    // In CI, also emits github-actions annotations.
    reporters: process.env['GITHUB_ACTIONS']
      ? ['verbose', 'github-actions']
      : ['verbose'],

    // All configs use 'forks' pool because onnxruntime-node is a native NAPI
    // addon that cannot load in worker threads. Individual configs tune
    // pool parallelism via maxForks / fileParallelism.
    pool: 'forks',
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      '@test': path.resolve(__dirname, '../../test'),
    },
  },
});
