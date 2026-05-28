import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Common resolve aliases
const resolve = {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@test': path.resolve(__dirname, './test'),
  },
};

// Base test configuration
const baseTestConfig = {
  globals: true,
  environment: 'node' as const,
  pool: 'forks' as const,
  setupFiles: ['./test/setup/unit.ts'],
  reporters: process.env['GITHUB_ACTIONS']
    ? ['verbose', 'github-actions']
    : ['verbose'],
  coverage: {
    provider: 'v8' as const,
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
};

const cpuCount = os.cpus().length;

export default defineConfig({
  test: {
    // Note: Vitest workspace can be defined inside a config file too in some versions
    // but usually it's a separate file. If separate file failed, let's try 
    // a dynamic config or multiple projects here if supported.
    
    // Fallback: Default to unit tests if no arguments provided
    ...baseTestConfig,
    include: ['test/unit/**/*.test.ts'],
    forks: {
      maxForks: Math.max(2, Math.min(cpuCount, 8)),
      minForks: 2,
    },
    testTimeout: 30000,
    hookTimeout: 15000,
    teardownTimeout: 10000,
  },
  resolve,
});
