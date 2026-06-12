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
 * Get the camoufox binary cache directory.
 * Uses PLAYWRIGHT_BROWSERS_PATH if set, otherwise the standard user cache location
 * that camoufox uses by default (~/.cache/camoufox on Linux).
 * We do NOT override HOME — that trick was unreliable and caused install/runtime mismatches.
 */
export function getBrowserCacheDir(): string {
    if (process.env['PLAYWRIGHT_BROWSERS_PATH']) {
        return process.env['PLAYWRIGHT_BROWSERS_PATH'];
    }
    // Mirror getCamoufoxBinaryPath() so both functions agree on the cache location
    const osPlatform = platform();
    if (osPlatform === 'win32') {
        const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
        return join(localAppData, 'camoufox', 'Cache');
    } else if (osPlatform === 'darwin') {
        return join(homedir(), 'Library', 'Caches', 'camoufox');
    } else {
        const cacheHome = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
        return join(cacheHome, 'camoufox');
    }
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
    const customPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    if (customPath) {
        env['PLAYWRIGHT_BROWSERS_PATH'] = customPath;
    } else {
        delete env['PLAYWRIGHT_BROWSERS_PATH'];
    }
    // Pass the session log file path so thread-workers can write lifecycle and
    // error events to the same log. Falls back to the global log if not set.
    const logFilePath = getLogger().getLogFilePath();
    if (logFilePath) {
        env['PI_RESEARCH_LOG_FILE'] = logFilePath;
    }
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
    const customPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    if (customPath) {
        return customPath;
    }

    const osPlatform = platform();

    if (osPlatform === 'win32') {
        const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
        // env-paths with name 'camoufox' and suffix '' produces LOCALAPPDATA/camoufox/Cache
        return join(localAppData, 'camoufox', 'Cache');
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
export function isFullMockMode(): boolean {
    return process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
           process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
}