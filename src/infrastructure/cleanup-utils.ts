import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.ts';

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Clean up stale Playwright/Camoufox profile directories.
 *
 * @param baseDir  Directory to scan. Defaults to os.tmpdir(). When using the
 *                 default, only entries with the 'playwright_firefoxdev_profile-'
 *                 prefix are considered. When an explicit baseDir is given, all
 *                 subdirectories are candidates (callers pass a dedicated dir).
 * @param staleMs  Age threshold in ms. Defaults to 30 days.
 */
export async function cleanupStaleProfiles(
  baseDir?: string,
  staleMs = DEFAULT_STALE_MS,
): Promise<{ removed: number; errors: number }> {
  const scanDir = baseDir ?? os.tmpdir();
  const usePrefix = baseDir === undefined;
  const prefix = 'playwright_firefoxdev_profile-';
  let removed = 0;
  let errors = 0;

  try {
    const entries = await fs.readdir(scanDir);
    const now = Date.now();

    for (const entry of entries) {
      if (usePrefix && !entry.startsWith(prefix)) continue;

      const fullPath = path.join(scanDir, entry);
      try {
        const stats = await fs.stat(fullPath);
        if (!stats.isDirectory()) continue;
        if (now - stats.mtimeMs > staleMs) {
          await fs.rm(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch (_e) {
        errors++;
      }
    }
  } catch (e) {
    logger.warn('[Cleanup] Failed to read directory for profile cleanup:', e);
  }

  if (removed > 0) {
    logger.log(`[Cleanup] Removed ${removed} stale browser profile directories.`);
  }

  return { removed, errors };
}
