/**
 * Root vitest config — delegates to the canonical unit test config.
 *
 * All test configs live under config/tooling/. This file exists so that
 * bare `npx vitest` or IDE integrations resolve to the unit test suite
 * without needing --config flags.
 *
 * For integration tests, use the dedicated configs:
 *   npm run test:integration:serial
 *   npm run test:integration:parallel
 *
 * To run all tests sequentially:
 *   npm run test:all
 */

import unitConfig from './config/tooling/vitest.config.unit.ts';

export default unitConfig;