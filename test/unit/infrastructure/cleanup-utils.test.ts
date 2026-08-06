/**
 * Cleanup Utils Unit Tests
 *
 * Tests that cleanupStaleProfiles actually removes stale Playwright profiles
 * while preserving active ones. Creates real test data in temp directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Partial-mock fs/promises so individual tests can force fs.rm to reject
// deterministically on every platform. By default rm delegates to the real
// implementation, so the success-path tests still perform genuine removals.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: actual, rm: vi.fn(actual.rm) };
});

// Partial-mock os.tmpdir so the "explicit baseDir IS the system temp dir" guard
// can be exercised against a sandbox directory instead of the real /tmp.
const osMockState = vi.hoisted(() => ({ tmpdir: null as string | null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const tmpdir = () => osMockState.tmpdir ?? actual.tmpdir();
  return { ...actual, default: { ...actual, tmpdir }, tmpdir };
});

describe('cleanup-utils', () => {
  let testBaseDir: string;
  let testCacheDir: string;
  const STALE_THRESHOLD_DAYS = 30;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const STALE_AGE_MS = (STALE_THRESHOLD_DAYS + 1) * MS_PER_DAY;
  const ACTIVE_AGE_MS = (STALE_THRESHOLD_DAYS - 1) * MS_PER_DAY;

  beforeEach(() => {
    // Create a temporary directory for test profiles. The path carries a
    // `pi-research` segment because the unrecognized-entry sweep now only runs
    // inside a dir that is provably pi-owned (mirrors the real profile dir,
    // which always ends in .../pi-research/profiles).
    testBaseDir = path.join(os.tmpdir(), `pi-research-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    testCacheDir = path.join(testBaseDir, 'ms-playwright');
    mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    osMockState.tmpdir = null;
    // Clean up test directory
    if (fs.existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
    // clearAllMocks (not restoreAllMocks) so the fs.rm partial mock keeps its
    // real-delegating implementation across tests; only call history is reset.
    vi.clearAllMocks();
  });

  /**
   * Helper: Create a test profile directory with files
   */
  function createProfile(profileId: string, ageMs: number): string {
    const profileDir = path.join(testCacheDir, profileId);
    mkdirSync(profileDir, { recursive: true });

    // Create typical profile files
    writeFileSync(path.join(profileDir, 'preferences.json'), JSON.stringify({ profileId }));
    writeFileSync(path.join(profileDir, 'session_state.json'), JSON.stringify({ active: true }));
    writeFileSync(path.join(profileDir, 'lockfile'), 'locked');

    // Set file mtime to make it appear old/new
    const now = Date.now();
    const fileTime = new Date(now - ageMs);
    utimesSync(profileDir, fileTime, fileTime);

    return profileDir;
  }

  /**
   * Helper: Create a non-profile directory (should be ignored)
   */
  function createNonProfile(dirName: string): string {
    const dirPath = path.join(testCacheDir, dirName);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(path.join(dirPath, 'random.txt'), 'not a profile');
    return dirPath;
  }

  /**
   * Helper: Verify a directory and its contents exist
   */
  function directoryExists(dirPath: string): boolean {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  }

  /**
   * Helper: Verify a directory was fully removed
   */
  function directoryFullyRemoved(dirPath: string): boolean {
    return !fs.existsSync(dirPath);
  }

  describe('cleanupStaleProfiles', () => {
    it('removes stale profiles older than threshold', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a stale profile (older than 30 days)
      const staleProfile = createProfile('stale-profile-123', STALE_AGE_MS);
      expect(directoryExists(staleProfile)).toBe(true);

      // Run cleanup
      const result = await cleanupStaleProfiles(testCacheDir);

      // Verify stale profile was removed
      expect(directoryFullyRemoved(staleProfile)).toBe(true);
      expect(result.removed).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('preserves active profiles younger than threshold', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create an active profile (newer than 30 days)
      const activeProfile = createProfile('active-profile-456', ACTIVE_AGE_MS);
      expect(directoryExists(activeProfile)).toBe(true);

      // Run cleanup
      const result = await cleanupStaleProfiles(testCacheDir);

      // Verify active profile was preserved
      expect(directoryExists(activeProfile)).toBe(true);
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('removes only stale profiles when mixed with active ones', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create multiple profiles with different ages
      const stale1 = createProfile('stale-1', STALE_AGE_MS);
      const stale2 = createProfile('stale-2', STALE_AGE_MS + MS_PER_DAY);
      const active1 = createProfile('active-1', ACTIVE_AGE_MS);
      const active2 = createProfile('active-2', ACTIVE_AGE_MS - MS_PER_DAY);

      // Run cleanup
      const result = await cleanupStaleProfiles(testCacheDir);

      // Verify only stale profiles were removed
      expect(directoryFullyRemoved(stale1)).toBe(true);
      expect(directoryFullyRemoved(stale2)).toBe(true);
      expect(directoryExists(active1)).toBe(true);
      expect(directoryExists(active2)).toBe(true);
      expect(result.removed).toBe(2);
      expect(result.errors).toBe(0);
    });

    it('reclaims empty + orphaned profile dirs regardless of age, sparing live ones and non-matching dirs', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      const young = new Date(Date.now() - ACTIVE_AGE_MS);

      // Empty leftovers Playwright leaves behind, both YOUNG — reclaimed (can't be active).
      const emptyArtifacts = path.join(testCacheDir, 'playwright-artifacts-abc123');
      const emptyProfile = path.join(testCacheDir, 'playwright_firefoxdev_profile-def456');
      mkdirSync(emptyArtifacts, { recursive: true });
      mkdirSync(emptyProfile, { recursive: true });
      utimesSync(emptyArtifacts, young, young);
      utimesSync(emptyProfile, young, young);

      // A YOUNG, non-empty profile left by a CRASHED run (no live owner — its `lockfile` is
      // not a real Firefox lock). The bug fix reclaims this regardless of age, instead of
      // letting it linger until a 30-day/1-hour threshold.
      const orphaned = createProfile('playwright_firefoxdev_profile-orphan', ACTIVE_AGE_MS);

      // A profile genuinely IN USE: a real, FRESH `.parentlock` marks a live owner — spared.
      const live = path.join(testCacheDir, 'playwright_firefoxdev_profile-live');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'preferences.json'), '{}');
      writeFileSync(path.join(live, '.parentlock'), ''); // fresh mtime ≈ now → treated as live
      utimesSync(live, young, young); // dir is old, but the lock file is fresh

      // A young, empty, NON-matching dir (e.g. the tsx compile cache) must be left alone.
      const otherEmpty = path.join(testCacheDir, 'tsx-1000');
      mkdirSync(otherEmpty, { recursive: true });
      utimesSync(otherEmpty, young, young);

      const result = await cleanupStaleProfiles(testCacheDir);

      expect(directoryFullyRemoved(emptyArtifacts)).toBe(true);
      expect(directoryFullyRemoved(emptyProfile)).toBe(true);
      expect(directoryFullyRemoved(orphaned)).toBe(true);
      expect(directoryExists(live)).toBe(true);
      expect(directoryExists(otherEmpty)).toBe(true);
      expect(result.removed).toBe(3);
      expect(result.errors).toBe(0);
    });

    it('handles empty cache directory', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Don't create any profiles
      const result = await cleanupStaleProfiles(testCacheDir);

      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('handles non-existent cache directory gracefully', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      const nonExistentDir = path.join(testBaseDir, 'does-not-exist');
      const result = await cleanupStaleProfiles(nonExistentDir);

      // Should complete without error
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('ignores non-profile directories', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a stale profile and a non-profile directory
      const staleProfile = createProfile('stale-123', STALE_AGE_MS);
      const nonProfile = createNonProfile('not-a-profile');

      const result = await cleanupStaleProfiles(testCacheDir);

      // Only the profile should be removed, non-profile should remain
      expect(directoryFullyRemoved(staleProfile)).toBe(true);
      expect(directoryExists(nonProfile)).toBe(true);
      expect(result.removed).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('counts errors when removal fails', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a stale profile eligible for removal.
      createProfile('stale-readonly', STALE_AGE_MS);

      // Force the removal to fail deterministically on every platform. A real
      // chmod(0o444)-based permission error is POSIX-only (Windows clears the
      // read-only bit under force:true, and even on POSIX it is a no-op for
      // root), so inject the failure at the fs.rm boundary the source uses.
      vi.mocked(fsp.rm).mockRejectedValueOnce(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      );

      const result = await cleanupStaleProfiles(testCacheDir);

      // The source must catch the rm rejection and count it, not propagate.
      expect(vi.mocked(fsp.rm)).toHaveBeenCalled();
      expect(result.errors).toBeGreaterThan(0);
      expect(result.removed).toBe(0);
    });

    it('handles profiles at the threshold boundary', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a profile exactly at the threshold (should be preserved)
      // 1 minute under threshold — reliably active despite test execution time and fs mtime precision
      const thresholdProfile = createProfile('threshold', STALE_THRESHOLD_DAYS * MS_PER_DAY - 60_000);
      // 1 minute over threshold — reliably stale
      const justStaleProfile = createProfile('just-stale', STALE_THRESHOLD_DAYS * MS_PER_DAY + 60_000);

      const result = await cleanupStaleProfiles(testCacheDir);

      expect(directoryExists(thresholdProfile)).toBe(true);
      expect(directoryFullyRemoved(justStaleProfile)).toBe(true);
      expect(result.removed).toBe(1);
    });

    it('handles profile with missing required files', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a directory without profile files (should still be treated as a profile)
      const incompleteProfile = path.join(testCacheDir, 'incomplete-profile');
      mkdirSync(incompleteProfile, { recursive: true });
      // Make it look stale
      const fileTime = new Date(Date.now() - STALE_AGE_MS);
      utimesSync(incompleteProfile, fileTime, fileTime);

      const result = await cleanupStaleProfiles(testCacheDir);

      // Incomplete stale profiles should still be cleaned up
      expect(directoryFullyRemoved(incompleteProfile)).toBe(true);
      expect(result.removed).toBe(1);
    });

    it('never deletes unrecognized entries when the explicit baseDir IS the system temp dir', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Simulate PI_RESEARCH_TMP_DIR pointed at the system temp dir (the browser
      // config's own tmpfs opt-in suggestion): baseDir === os.tmpdir(). The
      // sandbox path even contains a pi-research segment — the tmpdir identity
      // check must win regardless.
      osMockState.tmpdir = testCacheDir;

      // An unrelated same-user directory (ssh agent socket dir, build cache, …),
      // stale by every measure — previously recursively rm'd.
      const unrelated = createProfile('ssh-XXXXXXtest', STALE_AGE_MS);
      // A genuine leaked playwright profile in the same dir: still reclaimed.
      const leakedProfile = createProfile('playwright_firefoxdev_profile-leak', STALE_AGE_MS);

      const result = await cleanupStaleProfiles(testCacheDir);

      expect(directoryExists(unrelated)).toBe(true);
      expect(directoryFullyRemoved(leakedProfile)).toBe(true);
      expect(result.removed).toBe(1);
    });

    it('spares unrecognized entries in a non-pi-owned explicit baseDir (prefix-matched profiles still reclaimed)', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // A directory with no pi-research segment anywhere in its path: no positive
      // evidence of ownership, so unknown entries must be spared. (testBaseDir
      // itself carries a pi-research segment, so use a plain sandbox instead.)
      const plainBase = path.join(os.tmpdir(), `cleanup-foreign-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(plainBase, { recursive: true });
      try {
        const unknown = path.join(plainBase, 'user-build-cache');
        mkdirSync(unknown, { recursive: true });
        writeFileSync(path.join(unknown, 'data.bin'), 'x');
        const old = new Date(Date.now() - STALE_AGE_MS);
        utimesSync(unknown, old, old);

        const leaked = path.join(plainBase, 'playwright_firefoxdev_profile-foreign');
        mkdirSync(leaked, { recursive: true });
        writeFileSync(path.join(leaked, 'prefs.js'), '{}');
        utimesSync(leaked, old, old);

        const result = await cleanupStaleProfiles(plainBase);

        expect(fs.existsSync(unknown)).toBe(true);
        expect(fs.existsSync(leaked)).toBe(false);
        expect(result.removed).toBe(1);
      } finally {
        rmSync(plainBase, { recursive: true, force: true });
      }
    });

    it('does not sweep unknowns through a pi-research-named SYMLINK whose target lacks the marker', async (ctx) => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // The attack shape: a world-writable tmp dir where another user pre-created
      // `pi-research…` as a symlink into a directory we do NOT own. The CONFIGURED
      // path carries the pi-research segment, but the canonical target does not —
      // approving the sweep by the configured name would recursively rm THROUGH
      // the symlink into the victim directory.
      const victimBase = path.join(os.tmpdir(), `cleanup-victim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(victimBase, { recursive: true });
      const link = path.join(os.tmpdir(), `pi-research-link-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      try {
        try {
          fs.symlinkSync(victimBase, link, 'dir');
        } catch {
          // Symlink creation needs privilege on Windows — skip VISIBLY there
          // rather than return a silent green.
          return ctx.skip();
        }

        const old = new Date(Date.now() - STALE_AGE_MS);
        // A stale unknown entry in the VICTIM dir — previously deleted via the link.
        const unknown = path.join(victimBase, 'user-data');
        mkdirSync(unknown, { recursive: true });
        writeFileSync(path.join(unknown, 'important.bin'), 'x');
        utimesSync(unknown, old, old);
        // A genuinely leaked prefix-matched profile: still reclaimed either way.
        const leaked = path.join(victimBase, 'playwright_firefoxdev_profile-leak');
        mkdirSync(leaked, { recursive: true });
        writeFileSync(path.join(leaked, 'prefs.js'), '{}');
        utimesSync(leaked, old, old);

        const result = await cleanupStaleProfiles(link);

        expect(fs.existsSync(unknown)).toBe(true);
        expect(fs.existsSync(path.join(unknown, 'important.bin'))).toBe(true);
        expect(fs.existsSync(leaked)).toBe(false);
        expect(result.removed).toBe(1);
      } finally {
        try { fs.unlinkSync(link); } catch { /* may not exist */ }
        rmSync(victimBase, { recursive: true, force: true });
      }
    });

    it('handles very old profiles (months old)', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/browser/cleanup-utils.ts');

      // Create a profile that's 90 days old
      const veryOldProfile = createProfile('ancient', 90 * MS_PER_DAY);

      const result = await cleanupStaleProfiles(testCacheDir);

      expect(directoryFullyRemoved(veryOldProfile)).toBe(true);
      expect(result.removed).toBe(1);
    });
  });
});
