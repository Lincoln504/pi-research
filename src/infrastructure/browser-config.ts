import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { platform, homedir } from 'node:os';

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
