/**
 * Unit Test Setup
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { metrics } from '../../src/utils/metrics.ts';

// Global test configuration
process.env['NODE_ENV'] = 'test';
process.env['PI_RESEARCH_DEBUG'] = 'false';
process.env['PI_RESEARCH_FORCE_READY'] = 'true';

// Never auto-fetch the camoufox browser during unit tests. Unit tests mock the
// browser layer (so getCamoufoxBinaryPath() points at a non-existent temp dir),
// which would otherwise make the runtime browser-provisioning step in
// initializePool() think the binary is missing and trigger a real ~100MB
// `camoufox-js fetch`. This mirrors the unit-test job's CI env and is honoured
// by ensureBrowserInstalled(). A dedicated ensure-browser unit test overrides
// this per-case to exercise the fetch path.
process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1';

// Redirect the debug log to a throwaway temp path so error-path tests never
// append WARN/ERROR + stack traces to the user's real log. WARN/ERROR are
// written regardless of DEBUG, so without this, any test exercising a failure
// path pollutes ~/.pi/research/logs (or $TMPDIR/pi-research.log) in place.
process.env['PI_RESEARCH_LOG_PATH'] = path.join(os.tmpdir(), 'pi-research-test', 'pi-research.log');

// Increase EventEmitter max listeners to avoid warnings during tests.
// The pi-research extension registers signal handlers (SIGINT, SIGTERM, SIGHUP)
// which can cause warnings when tests load the extension multiple times.
process.setMaxListeners(20);

// Defensive metric isolation: the exported `metrics` singleton's SESSION registry is a
// process-global that code-under-test emits into. Cross-file determinism currently holds
// only because vitest uses forks + isolate (a fresh module registry per file). Reset the
// session registry after every test so a future isolate:false / shared-pool change can't
// make session-metric assertions non-deterministic. Run registries are per-call (scoped by
// runWithRunRegistry) and are unaffected by this.
afterEach(() => { metrics.clearSession(); });
