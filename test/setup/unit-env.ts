/**
 * Unit-test environment — MUST be imported before any module that (transitively)
 * imports src/logger.ts.
 *
 * The logger singleton binds its log-file path once, at module construction
 * (`buildDefaultDebugLogPath()` reads PI_RESEARCH_LOG_PATH in the constructor).
 * unit.ts sets these env vars in its module body — but its own static imports
 * (metrics.ts → logger.ts) are hoisted and evaluate FIRST, so the logger was
 * already constructed against the user's real /tmp/pi-research.log before the
 * redirect ever ran. Every error-path unit test then appended real WARN/ERROR
 * entries (with real-looking paths) to the shared production log — observed in
 * a live forensic pass as 6 spurious ERRORs and hundreds of WARNs per day that
 * materially slowed diagnosing real runs.
 *
 * Keeping the assignments in this import-free module, imported first, is the
 * ES-module-evaluation-order guarantee that they run before logger.ts does.
 */

import os from 'node:os';
import path from 'node:path';

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
// path pollutes the real shared log in place.
process.env['PI_RESEARCH_LOG_PATH'] = path.join(os.tmpdir(), 'pi-research-test', 'pi-research.log');
