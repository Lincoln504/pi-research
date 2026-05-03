import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Determine the project root directory.
 * Assumes this file is in src/infrastructure/
 */
export const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Determine the browser cache directory.
 * Priority:
 * 1. PLAYWRIGHT_BROWSERS_PATH environment variable
 * 2. Project-local .browser directory
 */
export function getBrowserCacheDir(): string {
    const envPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    if (envPath) return envPath;
    
    return join(PROJECT_ROOT, '.browser');
}

/**
 * Get the environment variables required to redirect Camoufox/Playwright 
 * to the local browser cache.
 */
export function getBrowserEnv(): Record<string, string> {
    const cacheDir = getBrowserCacheDir();
    
    // Camoufox uses os.homedir() which respects HOME/USERPROFILE
    const env: Record<string, string> = {
        ...process.env,
        'PLAYWRIGHT_BROWSERS_PATH': cacheDir,
    } as Record<string, string>;

    if (platform() === 'win32') {
        env['USERPROFILE'] = cacheDir;
    } else {
        env['HOME'] = cacheDir;
    }

    return env;
}

/**
 * Ensure the browser cache directory exists.
 */
export function ensureBrowserCacheDir(): string {
    const cacheDir = getBrowserCacheDir();
    if (!existsSync(cacheDir)) {
        try {
            mkdirSync(cacheDir, { recursive: true });
        } catch (_e) {
            // Ignore if already exists (race condition)
        }
    }
    return cacheDir;
}

/**
 * Get the expected path for Camoufox binaries within the cache.
 */
export function getCamoufoxBinaryPath(): string {
    const cacheDir = getBrowserCacheDir();
    if (platform() === 'win32') {
        return join(cacheDir, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache');
    } else if (platform() === 'darwin') {
        return join(cacheDir, 'Library', 'Caches', 'camoufox');
    } else {
        return join(cacheDir, '.cache', 'camoufox');
    }
}
