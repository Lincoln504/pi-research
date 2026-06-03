/**
 * Integration test config — serial group
 *
 * Files in this group share the global BrowserPoolManager singleton and/or
 * the global service registry. They MUST run one file at a time to prevent
 * pool lifecycle collisions and service registry conflicts.
 *
 * Files: browser-pool-failover, concurrent-operations, error-recovery,
 *        research-workflow, tool-execution, tools-connectivity, tools-extended
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'integration-serial',
    include: [
      'test/integration/browser-pool-failover.test.ts',
      'test/integration/concurrent-operations.test.ts',
      'test/integration/error-recovery.test.ts',
      'test/integration/research-workflow.test.ts',
      'test/integration/shutdown-perf.test.ts',
      'test/integration/tool-execution.test.ts',
      'test/integration/tools-connectivity.test.ts',
      'test/integration/tools-extended.test.ts',
    ],
    setupFiles: [],
    testTimeout: 300000,
    // Sequential file execution required: all files share the global
    // BrowserPoolManager singleton. Concurrent execution causes pool
    // lifecycle collisions ("Cannot execute a task on destroying pool").
    fileParallelism: false,
    pool: 'forks',
    hookTimeout: 120000,
    teardownTimeout: 60000,
  },
});
