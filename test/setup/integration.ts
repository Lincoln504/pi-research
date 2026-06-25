/**
 * Integration Test Setup
 *
 * Integration tests spawn real services and exercise failure paths, so — like
 * the unit setup — they must NOT append WARN/ERROR (written regardless of DEBUG)
 * to the user's real ~/.pi/research/logs. Redirect the log to a throwaway temp
 * path and mark the environment as a test run.
 */

import os from 'node:os';
import path from 'node:path';

process.env['NODE_ENV'] = 'test';

// Redirect diagnostics to a temp file unique to the integration run so no test
// (or spawned subprocess that inherits this env) pollutes the user's real log.
process.env['PI_RESEARCH_LOG_PATH'] = path.join(os.tmpdir(), 'pi-research-test-integration', 'pi-research.log');

process.setMaxListeners(20);
