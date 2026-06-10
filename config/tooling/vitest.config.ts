import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['node_modules', 'dist', '.tmp', 'test/integration'],
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
    // In GitHub Actions, add verbose so skipped test names appear in the log
    // alongside the auto-generated github-actions summary table.
    reporters: process.env['GITHUB_ACTIONS']
      ? ['verbose', 'github-actions']
      : ['verbose'],
    testTimeout: 60000,
    hookTimeout: 30000,
    teardownTimeout: 10000,
    pool: 'forks',
    includeSource: ['src/**/*.ts'],
    setupFiles: ['./test/setup/unit.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      '@test': path.resolve(__dirname, '../../test'),
    },
  },
});
