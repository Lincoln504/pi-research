import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../../logger.ts';

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Firefox/Camoufox profile lock files, cross-platform. A live browser holds:
 *  - Unix:   `lock` — a SYMLINK whose target encodes the owner: "<ip>:+<pid>" or "+<pid>",
 *            plus `.parentlock` (an fcntl-locked empty file).
 *  - Windows: `parent.lock` — a file kept OPEN by the live process. That is a liveness
 *            SIGNAL (see isWindowsParentLockHeld), not a safety net: a recursive delete
 *            has already removed the rest of the profile before it reaches this file.
 * The previous code checked for `.lock`, which Firefox/Camoufox never creates, so its
 * lock-awareness was inert. These are the real names.
 */
const LOCK_FILE_NAMES = ['lock', '.parentlock', 'parent.lock'];

/** Treat a lock whose owner PID we cannot read as "live" only if touched this recently,
 *  so a just-starting concurrent run is not reclaimed out from under itself. */
const LOCK_FRESHNESS_MS = 2 * 60 * 1000;

/**
 * Windows: is `parent.lock` still held open by a live browser?
 *
 * Firefox opens this file with no sharing, so while the browser runs ANY other
 * open of it fails with a sharing violation. That makes the probe positive
 * evidence of a live owner — the same standing as the Unix `lock` symlink's PID.
 *
 * Recency cannot substitute for it here: `parent.lock`'s mtime is stamped once at
 * browser startup and never refreshed, so every browser alive longer than
 * LOCK_FRESHNESS_MS read as dead — the normal case for a minutes-long research
 * run. Nor does "the OS refuses to delete a held-open file" save the profile:
 * `fs.rm({recursive:true})` unlinks entries one at a time, so prefs, cookies and
 * places are already gone by the time it reaches the locked file and fails.
 *
 * Returns null when the answer is not knowable, which callers treat as live —
 * sparing a leaked profile costs disk, deleting a live one corrupts a running run.
 */
async function isWindowsParentLockHeld(lockPath: string): Promise<boolean | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return false; // vanished — no live owner
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true; // held open
    return null; // unexpected — don't guess
  }
  await handle.close().catch(() => {});
  return false;
}

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
    // Windows has no `lock` symlink, so `parent.lock` is the only signal there. Probe
    // whether it is still held open — authoritative, unlike recency, which reads every
    // browser older than LOCK_FRESHNESS_MS as dead because the mtime is never refreshed.
    if (process.platform === 'win32' && name === 'parent.lock') {
      const held = await isWindowsParentLockHeld(lockPath);
      if (held !== null) return held;
      return true; // indeterminate — spare the profile
    }
    // `.parentlock` (no PID encoded) or an unreadable `lock`: use recency as the proxy.
    return Date.now() - lst.mtimeMs < LOCK_FRESHNESS_MS;
  }
  return false;
}

/** Canonicalize a path for identity comparison: realpath when resolvable (macOS
 *  /tmp is a symlink to /private/tmp), else a plain resolve; case-folded on
 *  Windows, whose filesystem compares case-insensitively. */
async function canonicalizeForCompare(p: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(p);
  } catch {
    resolved = path.resolve(p);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * May the unrecognized-entry deletion branch run against this explicit baseDir?
 *
 * That branch recursively rm's ANY stale subdirectory, so it is only safe inside
 * a directory pi-research owns outright. Two conditions gate it: the dir must not
 * BE the shared system temp dir (realpath-compared on both sides — a
 * PI_RESEARCH_TMP_DIR pointed at /tmp once made every same-user /tmp entry — ssh
 * agents, build caches — a sweep candidate), and the path must carry a
 * pi-research segment as positive evidence of ownership. When this returns false
 * the prefix-matched playwright profile cleanup still runs; only unknowns are
 * spared.
 */
async function isPiOwnedSweepDir(dir: string): Promise<boolean> {
  const [realDir, realTmp] = await Promise.all([
    canonicalizeForCompare(dir),
    canonicalizeForCompare(os.tmpdir()),
  ]);
  if (realDir === realTmp) return false;
  const hasPiSegment = (p: string) =>
    p.split(/[\\/]+/).some((segment) => segment.toLowerCase().startsWith('pi-research'));
  // Check the canonical path AND the given one: a symlinked profile dir whose
  // target lacks the marker is still recognizably ours by its configured path.
  return hasPiSegment(realDir) || hasPiSegment(path.resolve(dir));
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

  // Explicit-baseDir mode considers EVERY entry a candidate, including ones it
  // does not recognize; deleting unknowns is only permitted inside a dir that is
  // provably pi-owned and not the shared system temp dir (see isPiOwnedSweepDir).
  const sweepUnrecognized = usePrefix ? false : await isPiOwnedSweepDir(scanDir);

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
          await fs.rm(fullPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          removed++;
          continue;
        }

        // Unrecognized entry (only reachable with an explicit baseDir): be conservative —
        // only reclaim inside a pi-owned dir, and only if both old AND not live,
        // so nothing unknown is ever deleted promptly or outside our ownership.
        if (sweepUnrecognized && now - stats.mtimeMs > staleMs && !(await isProfileLive(fullPath))) {
          await fs.rm(fullPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
