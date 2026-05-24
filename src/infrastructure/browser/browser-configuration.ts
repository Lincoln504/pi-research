/**
 * Browser Configuration Utilities
 *
 * Provides configuration-related functions for browser management.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import * as crypto from 'node:crypto';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { getCamoufoxBinaryPath } from '../browser-config.ts';

const require = createRequire(import.meta.url);

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

/**
 * Check if the browser is available.
 */
export function isBrowserAvailable(): boolean {
    try {
        require.resolve('camoufox-js');
        // Also check if the binary exists in the projected path
        return existsSync(getCamoufoxBinaryPath());
    } catch {
        return false;
    }
}