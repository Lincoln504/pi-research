/**
 * Browser Configuration
 *
 * Consolidated configuration utilities for browser management.
 * Combines functionality from browser-config.ts and browser-configuration.ts.
 */

import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import { getLogger } from '../../logger.ts';
import { createRequire } from 'node:module';

// ============================================================================
// Binary Cache Management
// ============================================================================

/**
 * The directory where camoufox-js installs the browser on Windows.
 *
 * camoufox-js's userCacheDir("camoufox") resolves to
 *   os.homedir()/AppData/Local/camoufox/camoufox/Cache
 * — note the DOUBLED "camoufox" segment, and that it uses os.homedir() rather
 * than %LOCALAPPDATA%. We must mirror it exactly, otherwise isBrowserAvailable()
 * looks in the wrong place and every browser test silently skips on Windows
 * even though the binary downloaded and launches fine.
 */
function getWindowsCamoufoxDir(): string {
    return join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache');
}

/**
 * The custom camoufox location, if the user set one.
 *
 * CAMOUFOX_INSTALL_DIR takes precedence because it is camoufox-js's OWN
 * variable and the only one that can ever move the install: camoufox-js ≥0.12.0
 * resolves INSTALL_DIR from it. PLAYWRIGHT_BROWSERS_PATH is kept as a documented
 * alias, but on its own it only ever moved where we LOOK — camoufox went on
 * installing to the default cache, so setting it made the browser permanently
 * "not found" right after a successful download. Both are exported onward to
 * camoufox-js (getBrowserEnv, scripts/setup.cjs) so that install and lookup
 * cannot disagree.
 *
 * HISTORY: camoufox-js <0.12.0 hardcoded `userCacheDir("camoufox")` and
 * honoured NEITHER variable, which made this plumbing deliberately inert for
 * two pin cycles. The 0.12.0 refresh (2026-08-30) honours CAMOUFOX_INSTALL_DIR
 * again, so a custom location now relocates the install itself, not just our
 * lookup — the two can no longer disagree via version skew, but keep the dual
 * export (install + lookup) so they can never drift apart in future.
 */
function getCustomCamoufoxDir(): string | undefined {
    return process.env['CAMOUFOX_INSTALL_DIR'] || process.env['PLAYWRIGHT_BROWSERS_PATH'] || undefined;
}

/**
 * Get the camoufox binary cache directory.
 * Uses the custom location above if set, otherwise the standard user cache location
 * that camoufox uses by default (~/.cache/camoufox on Linux).
 * We do NOT override HOME — that trick was unreliable and caused install/runtime mismatches.
 */
export function getBrowserCacheDir(): string {
    const custom = getCustomCamoufoxDir();
    if (custom) {
        return custom;
    }
    // Mirror getCamoufoxBinaryPath() so both functions agree on the cache location
    const osPlatform = platform();
    if (osPlatform === 'win32') {
        return getWindowsCamoufoxDir();
    } else if (osPlatform === 'darwin') {
        return join(homedir(), 'Library', 'Caches', 'camoufox');
    } else {
        const cacheHome = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
        return join(cacheHome, 'camoufox');
    }
}

/**
 * Directory for transient per-worker browser profiles (Playwright/Camoufox
 * create one isolated profile per browser instance).
 *
 * Defaults to a DISK-backed location (~/.cache/pi-research/profiles) rather than
 * os.tmpdir(): on systems where /tmp is tmpfs (RAM-backed), placing several
 * browser profiles there consumes RAM and, with an OOM killer like earlyoom
 * active, can contribute to the whole session being killed. Override with
 * PI_RESEARCH_TMP_DIR (config.TMP_DIR) — e.g. point it at the system temp dir
 * to deliberately use tmpfs/RAM when there is memory headroom; profiles then
 * land in <TMP_DIR>/pi-research/profiles, never in TMP_DIR itself.
 *
 * The directory is created if missing, because Playwright requires the parent
 * of its mkdtemp profile dir to already exist.
 */
export function getBrowserProfileDir(config?: Config): string {
    const configured = (config || getConfig()).TMP_DIR;
    let dir: string;
    if (configured && configured.trim().length > 0) {
        // Containment invariant: profiles live in a pi-research-owned
        // SUBDIRECTORY of the configured dir, never the configured dir itself.
        // The pool-startup sweep (cleanupStaleProfiles with an explicit baseDir)
        // treats every entry of this directory as a reclaim candidate, so using
        // PI_RESEARCH_TMP_DIR verbatim — e.g. pointed at /tmp per the tmpfs
        // opt-in above — put unrelated same-user directories (ssh agents, build
        // caches) on the sweep's candidate list. The pi-research/profiles shape
        // also matches PI_BROWSER_MARKER's profile-path fallback in
        // browser-cleanup.ts, so orphan detection keeps working for relocated
        // profiles.
        dir = join(configured, 'pi-research', 'profiles');
    } else {
        const cacheHome = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
        dir = join(cacheHome, 'pi-research', 'profiles');
    }
    if (!existsSync(dir)) {
        try {
            mkdirSync(dir, { recursive: true });
        } catch (_e) {
            // Ignore race / permission errors; Playwright will surface a clear
            // error if the directory is genuinely unusable.
        }
    }
    return dir;
}

/**
 * Get environment for spawning browser worker processes.
 * Does not override HOME so camoufox uses its natural install location.
 *
 * CRITICAL: Browser workers run as cluster child processes and inherit process.env.
 * Since the config module loads .env file values into its internal config object
 * but does NOT set them into process.env, we must explicitly inject config values
 * here so workers can read them from their process.env copy.
 */
export function getBrowserEnv(config?: Config): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const customPath = getCustomCamoufoxDir();
    if (customPath) {
        env['PLAYWRIGHT_BROWSERS_PATH'] = customPath;
        // The one that camoufox-js actually reads. Without it the worker's
        // camoufox launches from the DEFAULT cache while everything on this side
        // resolves the custom path — the install/runtime mismatch this file's
        // header warns about, just arriving through a different door.
        env['CAMOUFOX_INSTALL_DIR'] = customPath;
    } else {
        delete env['PLAYWRIGHT_BROWSERS_PATH'];
        delete env['CAMOUFOX_INSTALL_DIR'];
    }
    // Tell thread-workers where to write their lifecycle/error log. Precedence:
    //   1. A user-set PI_RESEARCH_LOG_FILE (already copied from process.env above) wins —
    //      never clobber an explicit override.
    //   2. Otherwise propagate the resolved main-process log path so workers log to the
    //      same file. That path already honors the user's PI_RESEARCH_LOG_PATH.
    if (!env['PI_RESEARCH_LOG_FILE']) {
        const logFilePath = getLogger().getLogFilePath();
        if (logFilePath) {
            env['PI_RESEARCH_LOG_FILE'] = logFilePath;
        }
    }
    // Redirect the worker's temp dir to a disk-backed profile directory so
    // Playwright/Camoufox per-instance profiles do not land on a tmpfs (RAM)
    // /tmp. The worker's own logging is unaffected: it writes to
    // PI_RESEARCH_LOG_FILE (set above), not os.tmpdir(). TMP/TEMP are set too
    // for Windows. os.tmpdir() in the worker honours these.
    const profileDir = getBrowserProfileDir(config);
    env['TMPDIR'] = profileDir;
    env['TMP'] = profileDir;
    env['TEMP'] = profileDir;
    // Inject config values that browser workers read from process.env.
    // Without this, workers only see shell-set values — .env file values would be lost.
    const c = config || getConfig();
    env['PI_RESEARCH_SCRAPE_TIMEOUT_MS'] = String(c.SCRAPE_TIMEOUT_MS);
    env['PI_RESEARCH_SEARCH_TIMEOUT_MS'] = String(c.SEARCH_TIMEOUT_MS);
    env['PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS'] = String(c.HEALTH_CHECK_TIMEOUT_MS);
    return env;
}

/**
 * Ensure the browser cache directory exists (only relevant for custom PLAYWRIGHT_BROWSERS_PATH).
 */
export function ensureBrowserCacheDir(): string {
    const cacheDir = getBrowserCacheDir();
    if (!existsSync(cacheDir)) {
        try {
            mkdirSync(cacheDir, { recursive: true });
        } catch (_e) {
            // Ignore race condition
        }
    }
    return cacheDir;
}

/**
 * Get the expected path where camoufox installs its binaries.
 * Matches camoufox-js's own resolution logic.
 */
export function getCamoufoxBinaryPath(): string {
    const customPath = getCustomCamoufoxDir();
    if (customPath) {
        return customPath;
    }

    const osPlatform = platform();

    if (osPlatform === 'win32') {
        return getWindowsCamoufoxDir();
    } else if (osPlatform === 'darwin') {
        return join(homedir(), 'Library', 'Caches', 'camoufox');
    } else {
        // Linux and others
        const cacheHome = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
        return join(cacheHome, 'camoufox');
    }
}

// ============================================================================
// Scheduler Configuration
// ============================================================================

/**
 * Generate a version hash for the scheduler based on critical config values.
 * This allows us to detect when configuration changes and invalidate the cache.
 */
export function generateSchedulerVersion(config?: Config): string {
    const c = config || getConfig();
    const versionString = `v2:${c.WORKER_THREADS}:${c.WORKER_CONCURRENCY}:${c.MAX_CONCURRENT_RESEARCHERS}`;
    return crypto.createHash('sha256').update(versionString).digest('hex').substring(0, 16);
}

/**
 * Get the current number of worker threads from config.
 * This is a function instead of a constant to allow config changes to take effect
 * without requiring a process restart.
 */
export function getMaxWorkers(config?: Config): number {
    return (config || getConfig()).WORKER_THREADS;
}

/**
 * Get the current scheduler version hash.
 */
export function getSchedulerVersion(config?: Config): string {
    return generateSchedulerVersion(config);
}

// ============================================================================
// Display Environment
// ============================================================================

/**
 * Resolve the camoufox headless mode for the current platform.
 *
 * Returns true (true headless — no visible window) on Windows and macOS.
 * Historically Windows used headless:false because headless:true crashed Firefox
 * (exit 0x80000003, camoufox-js issue #614); that is fixed in camoufox-js >=0.10
 * (verified on Windows 11 x64 with 0.10.2: headless:true launches and navigates
 * reliably and, crucially, NO browser window pops up on the desktop). Using
 * headless:false on a real Windows desktop flashed visible, sometimes fullscreen,
 * browser windows during every scrape — true headless avoids that entirely.
 *
 * Returns true in all other cases (macOS, Linux+X11, Linux+Wayland, Linux TTY).
 *
 * On a bare Linux TTY (no DISPLAY, no WAYLAND_DISPLAY) true headless is the
 * default: Firefox renders fully offscreen, needs no display server and no Xvfb,
 * and navigates reliably (verified: cold launch ~0.8s, page nav ~0.3s on a bare
 * Debian box). The earlier 'virtual' default forced a hard Xvfb dependency that
 * is absent on minimal servers — when Xvfb is missing camoufox-js throws at
 * launch, and even when present, GTK/Xvfb rendering on a stripped box can stall
 * navigation, surfacing as a misleading "connection timed out" health error.
 *
 * Xvfb ('virtual') remains available as an explicit opt-in for users who have
 * installed it and want the marginal anti-detection benefit of a real virtual
 * framebuffer: set PI_RESEARCH_USE_XVFB=true. It only takes effect on a bare
 * Linux TTY (when a real display is present that display is used instead).
 *
 * Note: the JS camoufox port does not strip WAYLAND_DISPLAY / GDK_BACKEND /
 * MOZ_ENABLE_WAYLAND before spawning Xvfb (unlike the Python port), so
 * headless:'virtual' can still attach to a live compositor instead of the
 * spawned Xvfb — another reason true headless is the safe default.
 */
export function resolveHeadlessMode(): boolean | 'virtual' {
  const osPlatform = platform();
  // Windows + macOS: true headless (no visible window). camoufox-js >=0.10 no
  // longer crashes on Windows with headless:true (see the doc comment above).
  if (osPlatform !== 'linux') return true;
  if (process.env['DISPLAY']) return true;
  if (process.env['WAYLAND_DISPLAY']) return true;
  // Bare Linux TTY: true headless by default (no Xvfb required); opt into Xvfb
  // explicitly only when requested.
  if (process.env['PI_RESEARCH_USE_XVFB'] === 'true') return 'virtual';
  return true;
}

// ============================================================================
// Browser Availability Check
// ============================================================================

/**
 * Check if the browser is available for meaningful browser pool testing.
 * 
 * Returns false if:
 * - camoufox-js package is not installed
 * - camoufox binary is not present at expected path
 * - FULL_MOCK_MODE is active (both search and scrape mocked)
 * 
 * In FULL_MOCK_MODE, browser pool tests are not meaningful because:
 * - The FixedClusterPool deadlocks in Vitest fork context when both search and scrape are mocked
 * - Mocked tasks short-circuit in runTask() and don't exercise real browser behavior
 * - These tests verify real browser behavior: crash recovery, IPC routing, profile locking, etc.
 * 
 * Single point of control: all existing skipTests() checks use this function.
 */
/**
 * Whether the browser stack's NATIVE dependencies can actually load.
 *
 * `isBrowserAvailable()` answers a different question — is the camoufox binary on
 * disk — and a browser can be fully downloaded and still unable to launch. camoufox-js
 * requires `better-sqlite3`, whose binding is produced by a dependency INSTALL SCRIPT,
 * and npm 12 turns those off by default. The module then imports fine and throws only
 * when first used, so nothing notices until every browser worker dies mid-run with
 * "Could not locate the bindings file" and the run reports a network problem it does
 * not have.
 *
 * Measured, not assumed: of this package's native dependencies, only better-sqlite3
 * fails a scripts-blocked install. onnxruntime-node ships its binding inside its own
 * tarball, and lancedb, impit and html-to-markdown all resolve prebuilt platform
 * packages, so the knowledge store keeps working while search is dead — exactly the
 * split seen in the field.
 *
 * Opening an in-memory database is the only check that settles it: resolving the
 * module or stat-ing a path does not, because the failure is in the binding lookup at
 * first use. It costs a few milliseconds and is confined to diagnostics.
 */
export function probeBrowserNativeDeps(
    /** Injected for tests. Production callers pass nothing. */
    load: () => void = defaultNativeDepLoad,
): { ok: true } | { ok: false; error: string } {
    try {
        load();
        return { ok: true };
    } catch (err) {
        // First line only: the bindings error enumerates every path it tried, which is
        // pages of noise in a status block. The rest is in the log if it is wanted.
        return { ok: false, error: err instanceof Error ? err.message.split('\n')[0]!.trim() : String(err) };
    }
}

function defaultNativeDepLoad(): void {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as new (p: string) => { close(): void };
    const db = new Database(':memory:');
    db.close();
}

export function isBrowserAvailable(): boolean {
    if (isFullMockMode()) return false;
    try {
        import.meta.resolve('camoufox-js');
        return existsSync(getCamoufoxBinaryPath());
    } catch {
        return false;
    }
}

/**
 * Check whether search and scrape are mocked (used by tests that need real
 * browser behavior — mock mode short-circuits in runTask()).
 */
function isFullMockMode(): boolean {
    return process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
           process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
}
/**
 * How long the leader's health probe may take, end to end.
 *
 * This was a hardcoded 105s (45s probe + 60s queue-wait margin) and the verdict logic
 * that reads it is built on an arithmetic claim: the probe out-waits any task that can
 * hold a worker slot, so a probe that never reaches a worker really has found a wedge.
 * That claim held for the DEFAULT timeouts and for no others. `SEARCH_TIMEOUT_MS` and
 * `BROWSER_TASK_TIMEOUT_MS` are both settable to 120 000, so a search may legally hold
 * a slot for 240s — and a user who merely raised the search timeout would see healthy
 * pools reported as wedged, which aborts the run at the readiness gate.
 *
 * Deriving it instead makes the invariant hold by construction:
 *   - the longest a single task may hold a slot, plus
 *   - the probe's own work: the worker runs up to THREE navigation attempts (primary,
 *     retry, neutral-endpoint fallback) at `max(10s, HEALTH_CHECK_TIMEOUT_MS)` each,
 *     and a budget below that sum makes the fallback ladder unreachable — so raising
 *     HEALTH_CHECK_TIMEOUT_MS used to make the health check strictly worse.
 *
 * Floored at the historical 105s, kept as a floor rather than a default: the
 * derived value now exceeds it even at default timeouts once COLD_START_ALLOWANCE_MS
 * (below) is folded into `longestSlotHold` — a cold Firefox launch was always able to
 * hold a slot for close to that long, the 105s floor just didn't know it. The floor
 * still matters for a hypothetical config where the derived value would otherwise land
 * below it.
 */
export const HEALTHCHECK_MIN_BUDGET_MS = 45_000 + 60_000;

/** Navigation attempts executeHealthCheck makes: primary, retry, fallback endpoint. */
const HEALTHCHECK_NAV_ATTEMPTS = 3;

/**
 * Hard ceiling on a single Camoufox browser launch (see launchOnce() in
 * thread-worker-browser.ts, the single source of truth this mirrors — CI runners
 * (2 vCPU) can take up to ~60s to start Firefox under load, floored generously
 * above that).
 */
export const BROWSER_LAUNCH_TIMEOUT_MS = 90_000;

/**
 * Hard ceiling on creating one BrowserContext against an already-launched browser
 * (see acquireTaskContext() in thread-worker-browser.ts, the single source of
 * truth this mirrors).
 */
export const CONTEXT_CREATION_TIMEOUT_MS = 30_000;

/**
 * Worst-case time a worker can spend getting a browser+context ready before it
 * starts a task's actual work. Eager warmup is deliberately disabled (thundering-
 * herd avoidance — see thread-worker.ts), so the first task dispatched to a
 * freshly created or just-reset worker pays this in full, inline with the task
 * itself. Every deadline that bounds how long a task may legitimately hold a
 * worker slot has to include this on top of its own nav budget, or a completely
 * normal cold start on a fresh pool reads as a dead/wedged worker — the false
 * positive `runSearch`/`runScrape`'s task-timeout ceiling and this budget were
 * both built to eliminate, just triggered by a different clock.
 *
 * Deliberately NOT part of BROWSER_TASK_TIMEOUT_MS: that value is user-tunable
 * overhead for per-task work, and cold-start cost isn't something a user should
 * need to account for by hand when adjusting it.
 */
export const COLD_START_ALLOWANCE_MS = BROWSER_LAUNCH_TIMEOUT_MS + CONTEXT_CREATION_TIMEOUT_MS;

export function getHealthCheckBudgetMs(config?: Config): number {
    const c = (config || getConfig()) as Partial<Config>;
    // Each field is read defensively. A missing or non-finite value would otherwise
    // propagate a NaN into `setTimeout`, which Node coerces to 1ms — turning the health
    // probe's deadline into an instant failure. Falling back to the schema default is
    // the only reading that cannot silently invert the bound.
    const ms = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const longestSlotHold =
        Math.max(ms(c.SEARCH_TIMEOUT_MS, 45_000), ms(c.SCRAPE_TIMEOUT_MS, 15_000))
        + ms(c.BROWSER_TASK_TIMEOUT_MS, 10_000)
        + COLD_START_ALLOWANCE_MS;
    // Mirrors the worker's own floor in executeHealthCheck.
    const probeWork = HEALTHCHECK_NAV_ATTEMPTS * Math.max(10_000, ms(c.HEALTH_CHECK_TIMEOUT_MS, 10_000));
    return Math.max(HEALTHCHECK_MIN_BUDGET_MS, longestSlotHold + probeWork);
}
