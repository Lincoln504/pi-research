import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.ts';

/**
 * Clean up stale Playwright/Camoufox profile directories in /tmp.
 * Stale is defined as older than 4 hours.
 */
export async function cleanupStaleProfiles(): Promise<{ removed: number; errors: number }> {
    const tmpDir = os.tmpdir();
    const prefix = 'playwright_firefoxdev_profile-';
    let removed = 0;
    let errors = 0;

    try {
        const entries = await fs.readdir(tmpDir);
        const now = Date.now();
        const FOUR_HOURS = 4 * 60 * 60 * 1000;

        for (const entry of entries) {
            if (entry.startsWith(prefix)) {
                const fullPath = path.join(tmpDir, entry);
                try {
                    const stats = await fs.stat(fullPath);
                    if (now - stats.mtimeMs > FOUR_HOURS) {
                        await fs.rm(fullPath, { recursive: true, force: true });
                        removed++;
                    }
                } catch (e) {
                    errors++;
                    // Ignore errors for individual directories (might be in use)
                }
            }
        }
    } catch (e) {
        logger.warn('[Cleanup] Failed to read tmp directory for profile cleanup:', e);
    }

    if (removed > 0) {
        logger.log(`[Cleanup] Removed ${removed} stale browser profile directories.`);
    }
    
    return { removed, errors };
}
