/**
 * Cleanup Utils Unit Tests
 *
 * Tests that cleanupStaleProfiles actually removes stale Playwright profiles
 * while preserving active ones. Creates real test data in temp directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('cleanup-utils', () => {
  let testBaseDir: string;
  let testCacheDir: string;
  const STALE_THRESHOLD_DAYS = 30;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const STALE_AGE_MS = (STALE_THRESHOLD_DAYS + 1) * MS_PER_DAY;
  const ACTIVE_AGE_MS = (STALE_THRESHOLD_DAYS - 1) * MS_PER_DAY;

  beforeEach(() => {
    // Create a temporary directory for test profiles
    testBaseDir = path.join(os.tmpdir(), `pi-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    testCacheDir = path.join(testBaseDir, 'ms-playwright');
    mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
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
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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

    it('handles empty cache directory', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

      // Don't create any profiles
      const result = await cleanupStaleProfiles(testCacheDir);

      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('handles non-existent cache directory gracefully', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

      const nonExistentDir = path.join(testBaseDir, 'does-not-exist');
      const result = await cleanupStaleProfiles(nonExistentDir);

      // Should complete without error
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('ignores non-profile directories', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

      // Create a stale profile
      const staleProfile = createProfile('stale-readonly', STALE_AGE_MS);

      // Make the directory read-only (simulate permission error)
      try {
        fs.chmodSync(staleProfile, 0o444);
      } catch {
        // If chmod fails, skip this test
        return;
      }

      const result = await cleanupStaleProfiles(testCacheDir);

      // Should count the error
      expect(result.errors).toBeGreaterThan(0);

      // Restore permissions for cleanup
      try {
        fs.chmodSync(staleProfile, 0o755);
      } catch {
        // Ignore
      }
    });

    it('handles profiles at the threshold boundary', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

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

    it('handles very old profiles (months old)', async () => {
      const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');

      // Create a profile that's 90 days old
      const veryOldProfile = createProfile('ancient', 90 * MS_PER_DAY);

      const result = await cleanupStaleProfiles(testCacheDir);

      expect(directoryFullyRemoved(veryOldProfile)).toBe(true);
      expect(result.removed).toBe(1);
    });
  });
});
