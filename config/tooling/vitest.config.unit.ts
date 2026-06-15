import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cpuCount = os.cpus().length;
const maxForks = Math.max(2, Math.min(cpuCount, 8));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup/unit.ts'],
    pool: 'forks' as const,
    maxForks,
    minForks: 2,
    testTimeout: 30000,
    hookTimeout: 15000,
    teardownTimeout: 10000,
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
    reporters: process.env['GITHUB_ACTIONS']
      ? ['verbose', 'github-actions']
      : ['verbose'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      '@test': path.resolve(__dirname, '../../test'),
    },
  },
});
