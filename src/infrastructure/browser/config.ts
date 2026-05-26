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
 */
export function getBrowserEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const customPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    if (customPath) {
        env['PLAYWRIGHT_BROWSERS_PATH'] = customPath;
    } else {
        delete env['PLAYWRIGHT_BROWSERS_PATH'];
    }
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
    const versionString = `v2:${c.WORKER_THREADS}:${c.MAX_CONCURRENT_RESEARCHERS}`;
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
 * Check if the browser is available.
 */
export function isBrowserAvailable(): boolean {
    try {
        import.meta.resolve('camoufox-js');
        // Also check if the binary exists in the projected path
        return existsSync(getCamoufoxBinaryPath());
    } catch {
        return false;
    }
}