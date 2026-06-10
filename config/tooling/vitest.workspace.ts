/**
 * Vitest workspace configuration
 *
 * This workspace defines all test groups in the project. Running bare
 * `npx vitest run` uses this workspace, which ensures each group runs with
 * its appropriate resource limits.
 *
 * Groups:
 * - unit: Fast, isolated unit tests (no external dependencies)
 * - integration-serial: Integration tests that share global state (run one at a time)
 * - integration-parallel: Integration tests with isolated state (can run concurrently)
 *
 * USE:
 *   npx vitest run                    (runs all groups via workspace)
 *   npx vitest run --config config/tooling/vitest.config.unit.ts  (unit only)
 */

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'config/tooling/vitest.config.unit.ts',
  'config/tooling/vitest.config.integration.serial.ts',
  'config/tooling/vitest.config.integration.parallel.ts',
]);
