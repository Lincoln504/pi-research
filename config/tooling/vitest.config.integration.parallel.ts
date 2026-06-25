/**
 * Integration test config — parallel group
 *
 * Files in this group have NO shared singletons (no BrowserPoolManager, no
 * global service registry). Each test creates its own isolated tmpdir
 * database. They can all run concurrently with each other and alongside the
 * serial browser-pool group.
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    name: 'integration-parallel',
    include: [
      'test/integration/knowledge-migrations.test.ts',
      'test/integration/knowledge-models.test.ts',
      'test/integration/knowledge-stack.test.ts',
      'test/integration/openclaw.test.ts',
      'test/integration/research-knowledge-search.test.ts',
      'test/integration/setup.test.ts',
      'test/integration/shutdown.test.ts',
      'test/integration/skill-preuninstall.test.ts',
      'test/integration/youtube-transcript.test.ts',
    ],
    exclude: ['node_modules', 'dist', '.tmp'],
    setupFiles: ['./test/setup/integration.ts'],
    testTimeout: 180000,
    fileParallelism: true,
    pool: 'forks',
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
});
