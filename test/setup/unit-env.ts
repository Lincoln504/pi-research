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
import fs from 'node:fs';

process.env['NODE_ENV'] = 'test';
process.env['PI_RESEARCH_DEBUG'] = 'false';
process.env['PI_RESEARCH_FORCE_READY'] = 'true';

// Isolate the unit suite from the developer's REAL ~/.pi/research/config.env.
// getConfig() layers that file under process.env, so without this redirect unit-test
// behavior silently varies by machine: on a dev box carrying e.g.
// PI_RESEARCH_LLM_TIMEOUT_MS=900000, getLlmTimeoutMs() answered 900000 in tests while
// CI (no config.env) saw the 300000 default — a budget-sensitive test passed on CI and
// failed locally, purely from the host's personal config (found while fixing issue #9;
// same isolation philosophy as the log-path redirect below). Redirecting HOME moves
// config.env, state-dir, and knowledge-db discovery onto a throwaway directory.
// USERPROFILE is set too: os.homedir() reads HOME on POSIX but USERPROFILE on Windows,
// and the unit matrix runs on all three OSes. CI is unaffected — its runners have no
// ~/.pi/research to begin with, which is exactly the environment this creates.
const unitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-unit-home-'));
process.env['HOME'] = unitHome;
process.env['USERPROFILE'] = unitHome;

// The throwaway HOME is per worker process and used to outlive it forever:
// nothing removed it, so every `npm run test:unit` leaked one tmpdir (4,990
// were found on one dev machine). Remove our own when the worker exits, and
// opportunistically reclaim leaks older than 24h — no test run keeps a worker
// alive that long — while never touching dirs owned by concurrent runs.
try {
  process.on('exit', () => {
    try { fs.rmSync(unitHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith('pi-research-unit-home-')) continue;
    const dir = path.join(os.tmpdir(), entry);
    try {
      if (dir === unitHome) continue;
      if (fs.statSync(dir).mtimeMs < staleCutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* raced with another worker's sweep, or already gone */ }
  }
} catch { /* tmpdir unreadable — isolation above still applies */ }

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
