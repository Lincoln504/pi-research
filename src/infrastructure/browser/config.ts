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
 * variable and the only one that actually moves the install: camoufox-js
 * ≥0.12.0 resolves INSTALL_DIR from it, and every earlier version hardcoded
 * `userCacheDir("camoufox")` with no override at all. PLAYWRIGHT_BROWSERS_PATH
 * is kept as a documented alias, but on its own it only ever moved where we
 * LOOK — camoufox went on installing to the default cache, so setting it made
 * the browser permanently "not found" right after a successful download. Both
 * are now exported to camoufox-js (getBrowserEnv, scripts/setup.cjs) so the
 * install location and the lookup location cannot disagree.
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