/**
 * Integration test config — parallel group
 *
 * Files in this group have NO shared singletons (no BrowserPoolManager, no
 * global service registry). Each test creates its own isolated tmpdir
 * database. They can all run concurrently with each other and alongside the
 * serial browser-pool group.
 *
 * Files: knowledge-embedding-models, knowledge-migrations, knowledge-stack,
 *        setup, shutdown
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'integration-parallel',
    include: [
      'test/integration/knowledge-embedding-models-synthetic.test.ts',
      'test/integration/knowledge-migrations.test.ts',
      'test/integration/knowledge-stack.test.ts',
      'test/integration/setup.test.ts',
      'test/integration/shutdown.test.ts',
    ],
    setupFiles: [],
    testTimeout: 180000,
    fileParallelism: true,
    pool: 'forks',
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
