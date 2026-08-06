/**
 * DiskSpaceChecker unit tests.
 *
 * The low-space warning writes to bare stderr because the checker runs inside
 * the logger itself (using the logger would be circular). When the parent
 * process has closed the pipe, that write throws EPIPE/ERR_STREAM_DESTROYED —
 * pre-guard, the surrounding statfs catch swallowed it and flipped the verdict
 * back to "has space" (its assume-OK recovery), defeating the very check that
 * was mid-report. The guard must contain the write failure and keep the
 * low-space verdict intact.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ bavail: Number.MAX_SAFE_INTEGER }));

// Pass-through fs mock: only statfsSync is faked, so the checker sees a
// controllable free-space figure without depending on the host's real disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statfsSync = (() => ({ bavail: mockState.bavail, bsize: 512 })) as unknown as typeof actual.statfsSync;
  return { ...actual, default: { ...actual, statfsSync }, statfsSync };
});

let DiskSpaceChecker: (typeof import('../../../src/utils/disk-space-checker.ts'))['DiskSpaceChecker'];

beforeAll(async () => {
  // The unit-test setup file loads logger.ts → disk-space-checker.ts BEFORE this
  // file's vi.mock('node:fs') registration, so a static import would hand back
  // the cached class bound to the REAL fs and the statfs fake would never fire.
  // Re-evaluating after resetModules resolves node:fs through the mock registry.
  vi.resetModules();
  ({ DiskSpaceChecker } = await import('../../../src/utils/disk-space-checker.ts'));
});

describe('DiskSpaceChecker', () => {
  it('reports OK when space is ample', () => {
    mockState.bavail = Number.MAX_SAFE_INTEGER;
    expect(new DiskSpaceChecker().checkDiskSpace('/anywhere')).toBe(true);
  });

  it('reports low disk space as false even when stderr is a dead pipe', () => {
    mockState.bavail = 0;
    const originalWrite = process.stderr.write;
    // Simulate the parent having closed the pipe: the next write throws.
    (process.stderr.write as unknown) = () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    try {
      const checker = new DiskSpaceChecker();
      let verdict: boolean | undefined;
      expect(() => { verdict = checker.checkDiskSpace('/anywhere'); }).not.toThrow();
      // The verdict must stay "no space" — pre-guard, the EPIPE landed in the
      // statfs catch, whose assume-OK recovery reported true on a full disk.
      expect(verdict).toBe(false);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
