/**
 * Integration test config — serial group
 *
 * Files in this group share the global BrowserPoolManager singleton and/or
 * the global service registry. They MUST run one file at a time to prevent
 * pool lifecycle collisions and service registry conflicts.
 *
 * Files: all browser-pool, concurrent-operations, error-recovery,
 *        research-workflow, tools-*, link-description-enqueue,
 *        tool-execution, tools-connectivity, tools-extended
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'test/integration/browser-pool-failover.test.ts',
      'test/integration/browser-pool-orchestration.test.ts',
      'test/integration/concurrent-operations.test.ts',
      'test/integration/error-recovery.test.ts',
      'test/integration/link-description-enqueue.test.ts',
      'test/integration/research-workflow.test.ts',
      'test/integration/tool-execution.test.ts',
      'test/integration/tools-connectivity.test.ts',
      'test/integration/tools-extended.test.ts',
    ],
    setupFiles: [],
    testTimeout: 180000,
    // Sequential file execution required: all files share the global
    // BrowserPoolManager singleton. Concurrent execution causes pool
    // lifecycle collisions ("Cannot execute a task on destroying pool").
    fileParallelism: false,
    pool: 'forks',
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
