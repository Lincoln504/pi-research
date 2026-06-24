import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../../logger.ts';

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Firefox/Camoufox profile lock files, cross-platform. A live browser holds:
 *  - Unix:   `lock` — a SYMLINK whose target encodes the owner: "<ip>:+<pid>" or "+<pid>",
 *            plus `.parentlock` (an fcntl-locked empty file).
 *  - Windows: `parent.lock` — a file kept OPEN by the live process (so the OS refuses to
 *            delete it, which is itself a safety net against reclaiming an in-use profile).
 * The previous code checked for `.lock`, which Firefox/Camoufox never creates, so its
 * lock-awareness was inert. These are the real names.
 */
const LOCK_FILE_NAMES = ['lock', '.parentlock', 'parent.lock'];

/** Treat a lock whose owner PID we cannot read as "live" only if touched this recently,
 *  so a just-starting concurrent run is not reclaimed out from under itself. */
const LOCK_FRESHNESS_MS = 2 * 60 * 1000;

/** Parse the owner PID out of a Firefox `lock` symlink target ("<ip>:+<pid>" / "+<pid>"). */
function parsePidFromLockTarget(target: string): number | null {
  const m = /\+(\d+)\s*$/.exec(target);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Cross-platform liveness probe for a PID (no signal is actually sent with signal 0). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = exists but owned by another user (alive).
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Best-effort, cross-platform check for whether a profile directory is held by a LIVE
 * browser. Returns true ONLY on positive evidence of a live owner, so a stale lock left by
 * a crashed process never pins the directory. A directory with no lock file is not live.
 */
async function isProfileLive(profileDir: string): Promise<boolean> {
  for (const name of LOCK_FILE_NAMES) {
    const lockPath = path.join(profileDir, name);
    let lst;
    try {
      lst = await fs.lstat(lockPath);
    } catch {
      continue; // this lock file is absent — check the next
    }
    // Unix `lock` symlink: authoritative — read the owner PID and probe liveness.
    if (lst.isSymbolicLink()) {
      try {
        const pid = parsePidFromLockTarget(await fs.readlink(lockPath));
        if (pid !== null) return isPidAlive(pid);
      } catch {
        // unreadable symlink — fall back to freshness below
      }
    }
    // `.parentlock` / `parent.lock` (no PID encoded), or an unreadable `lock`: use recency
    // as the liveness proxy. On Windows the file is also held open, so an attempted delete
    // of a genuinely-live profile fails harmlessly regardless of this heuristic.
    return Date.now() - lst.mtimeMs < LOCK_FRESHNESS_MS;
  }
  return false;
}

/**
 * Reclaim leaked Playwright/Camoufox profile directories.
 *
 * Playwright self-cleans a profile on a normal `browser.close()`; only an ABNORMAL exit
 * (crash, SIGKILL, OOM-kill) leaves one behind. This runs at pool startup, before this
 * process opens any browser of its own, so any profile WITHOUT a live owning process is
 * definitively orphaned and reclaimed regardless of age or emptiness. Profiles still in use
 * by a concurrent pi-research instance are detected via {@link isProfileLive} and spared.
 *
 * @param baseDir  Directory to scan. Defaults to os.tmpdir() (legacy pre-upgrade location);
 *                 with the default, only `playwright_firefoxdev_profile-` entries are
 *                 considered. With an explicit baseDir (the dedicated profile dir), every
 *                 subdirectory is a candidate.
 * @param staleMs  Age fallback (default 30 days) used ONLY for unrecognized non-profile
 *                 entries, which are never reclaimed while they could be recent.
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

        const isProfileLike =
          entry.startsWith(prefix) || entry.startsWith('playwright-artifacts-');

        if (isProfileLike) {
          // Empty dirs (e.g. an artifact dir Playwright emptied but left behind) can never
          // be an active profile — reclaim immediately.
          const inner = await fs.readdir(fullPath);
          if (inner.length === 0) {
            await fs.rmdir(fullPath);
            removed++;
            continue;
          }
          // Non-empty: reclaim unless a live browser still owns it. This is what fixes the
          // real leak — a recent, non-empty, crash-left profile is now reclaimed instead of
          // lingering until a 30-day (or 1-hour) age threshold.
          if (await isProfileLive(fullPath)) {
            logger.debug(`[Cleanup] Skipping profile ${entry} — owned by a live browser`);
            continue;
          }
          await fs.rm(fullPath, { recursive: true, force: true });
          removed++;
          continue;
        }

        // Unrecognized entry (only reachable with an explicit baseDir): be conservative —
        // only reclaim if both old AND not live, so we never delete something unknown promptly.
        if (now - stats.mtimeMs > staleMs && !(await isProfileLive(fullPath))) {
          await fs.rm(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch (_e) {
        // A live Windows profile refuses deletion (file held open) and lands here — safe.
        errors++;
      }
    }
  } catch (e) {
    logger.warn('[Cleanup] Failed to read directory for profile cleanup:', e);
  }

  if (removed > 0) {
    logger.log(`[Cleanup] Removed ${removed} leaked browser profile directories.`);
  }

  return { removed, errors };
}
