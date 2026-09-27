/**
 * Eval config — model-backed calibration runs (test/evals/**\/*.eval.ts).
 *
 * NOT part of CI or `npm test`: evals make real model calls and need the user's
 * pi credentials. No unit setup file on purpose — it swaps HOME for a temp dir,
 * which would hide ~/.pi/agent (models.json, auth.json). Run one file at a time,
 * one test at a time, to stay under provider rate limits.
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'eval',
    include: ['test/evals/**/*.eval.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
