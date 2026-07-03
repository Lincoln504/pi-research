import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FileLockService } from '../../../src/infrastructure/file-lock-service.ts';
import type { IProcessLifecycle } from '../../../src/core/interfaces/process-interfaces.ts';

/**
 * Minimal IProcessLifecycle stub — only the two methods FileLockService calls are
 * meaningful; the rest throw so an unexpected code path fails loudly. No real
 * ps/powershell is ever spawned, keeping the suite hermetic and cross-platform.
 */
function makeStubLifecycle(opts: {
  ownStartTime?: number | null;
  isAlive: (pid: number, expectedStartTime?: number | null) => boolean;
  onIsAlive?: () => void;
}): IProcessLifecycle {
  const notImpl = () => { throw new Error('not implemented in stub'); };
  return {
    async isProcessAlive(pid: number, expectedStartTime?: number | null): Promise<boolean> {
      opts.onIsAlive?.();
      return opts.isAlive(pid, expectedStartTime);
    },
    async getCurrentProcessStartTime(): Promise<number | null> {
      return opts.ownStartTime ?? null;
    },
    isProcessAliveSync: notImpl,
    isPidAlive: notImpl,
    getCurrentPid: () => process.pid,
    getProcessStartTime: notImpl,
    waitForProcessTermination: notImpl,
    isCurrentProcess: notImpl,
    getProcessInfo: notImpl,
    name: 'process-lifecycle',
    lifecycle: 0,
  } as unknown as IProcessLifecycle;
}

describe('FileLockService', () => {
  let tmpDir: string;
  let lockFilePath: string;
  let service: FileLockService;

  beforeEach(async () => {
    // mkdtemp atomically creates a unique, owner-only (0o700) dir — avoids the
    // predictable-name temp-file pattern CodeQL flags.
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-lock-test-'));
    lockFilePath = path.join(tmpDir, 'test.lock');
  });

  afterEach(async () => {
    // Dispose service if still present
    if (service) {
      try {
        await service.dispose();
      } catch {
        // Ignore dispose errors in cleanup
      }
    }
    // Remove temp directory
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---------------------------------------------------------------------------
  // Basic lock acquisition and release
  // ---------------------------------------------------------------------------

  describe('basic lock acquisition and release', () => {
    it('acquireLock() creates a lock file with JSON containing the service UUID and PID', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();

      const content = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
      expect(parsed.uuid).toBe(service.getLockUuid());
      expect(parsed.pid).toBe(process.pid);

      await service.releaseLock();
    });

    it('after releaseLock() the lock file no longer exists', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();
      await service.releaseLock();

      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('reading the lock file before release returns JSON with the UUID written during acquisition', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();

      const content = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
      expect(parsed.uuid).toBe(service.getLockUuid());

      await service.releaseLock();
    });
  });



  // ---------------------------------------------------------------------------
  // Stale lock recovery
  // ---------------------------------------------------------------------------

  describe('stale lock recovery', () => {
    it('acquireLock() succeeds and replaces a stale lock file (mtime 40 s ago)', async () => {
      // Write a lock file with a foreign UUID
      const foreignUuid = crypto.randomUUID();
      await fs.writeFile(lockFilePath, foreignUuid, 'utf-8');

      // Back-date the mtime by 40 seconds
      const staleTime = new Date(Date.now() - 40_000);
      await fs.utimes(lockFilePath, staleTime, staleTime);

      service = new FileLockService({
        lockFilePath,
        lockTimeout: 5000,
        lockRetryDelay: 1,
      });
      await service.initialize();

      // Should succeed without timing out
      await expect(service.acquireLock()).resolves.toBeUndefined();

      // New content must contain our service's UUID, not the foreign one
      const content = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
      expect(parsed.uuid).toBe(service.getLockUuid());
      expect(parsed.uuid).not.toBe(foreignUuid);

      await service.releaseLock();
    });
  });

  describe('live-owner lock protection', () => {
    it('does NOT steal a lock from a live owner aged past lockStaleThreshold but within liveOwnerStaleThreshold', async () => {
      // A live writer (this process) holding the lock during a slow critical
      // section must never have it stolen — that would let two writers run the
      // same read-modify-write and lose an update.
      const foreignUuid = crypto.randomUUID();
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: foreignUuid, pid: process.pid }), 'utf-8');
      const aged = new Date(Date.now() - 40_000); // 40s: > 15s stale, < 120s live-stale
      await fs.utimes(lockFilePath, aged, aged);

      service = new FileLockService({
        lockFilePath,
        lockTimeout: 300, // give up quickly — a timeout is the expected outcome
        lockRetryDelay: 10,
      });
      await service.initialize();

      await expect(service.acquireLock()).rejects.toThrow(/Failed to acquire lock/);

      // The live owner's lock must be intact (not stolen).
      const content = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
      expect(parsed.uuid).toBe(foreignUuid);
    });

    it('reclaims a fresh lock whose owner process is dead', async () => {
      const foreignUuid = crypto.randomUUID();
      const deadPid = 2147483646; // not a live process → owner-liveness check fails
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: foreignUuid, pid: deadPid }), 'utf-8');
      // Fresh mtime (no back-dating): a dead owner must be reclaimed regardless of age.

      service = new FileLockService({ lockFilePath, lockTimeout: 5000, lockRetryDelay: 1 });
      await service.initialize();

      await expect(service.acquireLock()).resolves.toBeUndefined();
      const content = await fs.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
      expect(parsed.uuid).toBe(service.getLockUuid());

      await service.releaseLock();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-owner release is a no-op
  // ---------------------------------------------------------------------------

  describe('non-owner release', () => {
    it('releaseLock() does not delete a lock file that was overwritten by a different UUID', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      // Acquire the lock so the service holds a handle
      await service.acquireLock();

      // Overwrite the lock file content with a foreign UUID (simulates lock theft)
      const otherUuid = crypto.randomUUID();
      await fs.writeFile(lockFilePath, otherUuid, 'utf-8');

      // releaseLock() should detect the UUID mismatch and NOT delete the file
      await service.releaseLock();

      // File must still exist with the other UUID
      const content = await fs.readFile(lockFilePath, 'utf-8');
      expect(content.trim()).toBe(otherUuid);

      // Clean up manually
      await fs.unlink(lockFilePath);
    });
  });

  // ---------------------------------------------------------------------------
  // withLock wrapper
  // ---------------------------------------------------------------------------

  describe('withLock wrapper', () => {
    it('executes the callback and the lock file exists during execution, is gone after', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      let lockExistedDuringCallback = false;

      await service.withLock(async () => {
        try {
          await fs.access(lockFilePath);
          lockExistedDuringCallback = true;
        } catch {
          lockExistedDuringCallback = false;
        }
      });

      expect(lockExistedDuringCallback).toBe(true);

      // Lock file should be gone after withLock resolves
      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('releases the lock even when the callback throws', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      const callbackError = new Error('callback failed');

      await expect(
        service.withLock(async () => {
          throw callbackError;
        }),
      ).rejects.toThrow('callback failed');

      // Lock file must be deleted despite the throw
      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('supports re-entrancy within the same async flow', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.withLock(async () => {
        expect(service.isLocked()).toBe(true);
        // Nested lock
        await service.withLock(async () => {
          expect(service.isLocked()).toBe(true);
          const content = await fs.readFile(lockFilePath, 'utf-8');
          const parsed = JSON.parse(content.trim()) as { uuid: string; pid: number };
          expect(parsed.uuid).toBe(service.getLockUuid());
        });
        expect(service.isLocked()).toBe(true);
      });
      expect(service.isLocked()).toBe(false);
    });

    it('correctly serializes concurrent non-nested calls on the same instance', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      const events: string[] = [];
      const task1 = service.withLock(async () => {
        events.push('1:start');
        await new Promise(r => setTimeout(r, 50));
        events.push('1:end');
      });

      const task2 = service.withLock(async () => {
        events.push('2:start');
        await new Promise(r => setTimeout(r, 50));
        events.push('2:end');
      });

      await Promise.all([task1, task2]);

      expect(events).toEqual(['1:start', '1:end', '2:start', '2:end']);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout error message
  // ---------------------------------------------------------------------------

  describe('timeout error message', () => {
    it('rejection message matches "Failed to acquire lock" when a non-stale lock exists', async () => {
      // Write a fresh (non-stale) lock file
      await fs.writeFile(lockFilePath, crypto.randomUUID(), 'utf-8');

      service = new FileLockService({
        lockFilePath,
        lockTimeout: 50,
        lockRetryDelay: 1,
      });
      await service.initialize();

      await expect(service.acquireLock()).rejects.toThrow('Failed to acquire lock');
    });
  });

  // ---------------------------------------------------------------------------
  // PID + start-time (PID-reuse-safe) liveness
  // ---------------------------------------------------------------------------

  describe('PID+start-time liveness (processLifecycle wired)', () => {
    it('records our own startTime in the lock content when it resolves', async () => {
      const lifecycle = makeStubLifecycle({ ownStartTime: 123456, isAlive: () => true });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle });
      await service.initialize();
      await service.acquireLock();

      const parsed = JSON.parse((await fs.readFile(lockFilePath, 'utf-8')).trim()) as { uuid: string; pid: number; startTime?: number };
      expect(parsed.startTime).toBe(123456);
      await service.releaseLock();
    });

    it('OMITS startTime when our own lookup fails (writes a legacy-shape lock)', async () => {
      const lifecycle = makeStubLifecycle({ ownStartTime: null, isAlive: () => true });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle });
      await service.initialize();
      await service.acquireLock(); // must not throw despite the null start time

      const parsed = JSON.parse((await fs.readFile(lockFilePath, 'utf-8')).trim()) as { uuid: string; pid: number; startTime?: number };
      expect('startTime' in parsed).toBe(false);
      await service.releaseLock();
    });

    it('reclaims a FRESH foreign-PID lock that is alive but start-time differs (PID reuse) — the bare check cannot', async () => {
      // A FOREIGN pid that is alive NOW (bare kill(0) succeeds) but whose real start
      // time differs from the one recorded in the lock — i.e. that PID was recycled
      // by an unrelated process. Fresh mtime, so only the start-time mismatch can
      // justify reclaim; a bare process.kill(pid,0) check would wrongly see "alive".
      const FOREIGN = 424242;
      const RECORDED = 999_000; // stale start time written into the lock
      const REAL_NOW = 111_222;  // the recycled process's actual start time
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: crypto.randomUUID(), pid: FOREIGN, startTime: RECORDED }), 'utf-8');

      const lifecycle = makeStubLifecycle({
        ownStartTime: 111,
        // Bare check (no expected) → pid is live; PID+startTime check → only the REAL
        // start time matches, and RECORDED != REAL_NOW, so the owner reads as dead.
        isAlive: (_pid, expected) => (expected === undefined || expected === null) ? true : expected === REAL_NOW,
      });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle, lockTimeout: 2000, lockRetryDelay: 5 });
      await service.initialize();

      await expect(service.acquireLock()).resolves.toBeUndefined();
      const parsed = JSON.parse((await fs.readFile(lockFilePath, 'utf-8')).trim()) as { uuid: string };
      expect(parsed.uuid).toBe(service.getLockUuid());
      await service.releaseLock();
    });

    it('reclaims a FRESH same-PID lock whose recorded start-time differs from ours (our PID was recycled)', async () => {
      // The lock's pid equals our current pid, but its recorded start time is not
      // ours — a predecessor process held our PID and died. The start-time-aware
      // self short-circuit must treat this as dead, not "our own live lock".
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: crypto.randomUUID(), pid: process.pid, startTime: 777_000 }), 'utf-8');
      const lifecycle = makeStubLifecycle({ ownStartTime: 111, isAlive: () => true });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle, lockTimeout: 2000, lockRetryDelay: 5 });
      await service.initialize();

      await expect(service.acquireLock()).resolves.toBeUndefined();
      const parsed = JSON.parse((await fs.readFile(lockFilePath, 'utf-8')).trim()) as { uuid: string };
      expect(parsed.uuid).toBe(service.getLockUuid());
      await service.releaseLock();
    });

    it('falls back to a bare-PID check for a legacy lock (no startTime) — dead PID reclaimed', async () => {
      const deadPid = 2147483646;
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: crypto.randomUUID(), pid: deadPid }), 'utf-8');
      const lifecycle = makeStubLifecycle({
        ownStartTime: 111,
        isAlive: (pid) => pid !== deadPid, // bare check (no expectedStartTime) → dead
      });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle, lockTimeout: 2000, lockRetryDelay: 5 });
      await service.initialize();

      await expect(service.acquireLock()).resolves.toBeUndefined();
      await service.releaseLock();
    });

    it('memoizes the contended-owner check — one liveness call per episode, NOT per retry tick', async () => {
      // A live owner with a fresh lock is waited out until timeout. Across the many
      // retry ticks the owner never changes, so its (pid,startTime) liveness must be
      // checked exactly once — the regression guard against a ps/powershell storm.
      let calls = 0;
      const FOREIGN = 424242; // foreign pid → the processLifecycle path (not the self short-circuit)
      const RECORDED = 555;
      await fs.writeFile(lockFilePath, JSON.stringify({ uuid: crypto.randomUUID(), pid: FOREIGN, startTime: RECORDED }), 'utf-8');
      const lifecycle = makeStubLifecycle({
        ownStartTime: 111,
        isAlive: () => true, // always alive → never reclaimed → loop churns to timeout
        onIsAlive: () => { calls++; },
      });
      service = new FileLockService({ lockFilePath, processLifecycle: lifecycle, lockTimeout: 200, lockRetryDelay: 5 });
      await service.initialize();
      // Ignore any liveness call made by cleanupStaleLocksOnStartup during init;
      // we're measuring the acquire() retry loop's per-episode memoization.
      calls = 0;

      await expect(service.acquireLock()).rejects.toThrow(/Failed to acquire lock/);
      // Many ticks happened (200ms / 5ms ≈ 40), but the stable owner is checked once.
      expect(calls).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent lock safety
  // ---------------------------------------------------------------------------

  describe('concurrent lock safety', () => {
    it('two instances on the same path acquire the lock sequentially without corruption', async () => {
      const lockFilePath2 = lockFilePath; // shared path

      const serviceA = new FileLockService({
        lockFilePath: lockFilePath2,
        lockTimeout: 5000,
        lockRetryDelay: 5,
      });
      const serviceB = new FileLockService({
        lockFilePath: lockFilePath2,
        lockTimeout: 5000,
        lockRetryDelay: 5,
      });

      // Track which service held the lock and when
      const events: string[] = [];

      try {
        await serviceA.initialize();
        await serviceB.initialize();

        // Run both concurrently; each acquires, records, then releases
        const taskA = serviceA.withLock(async () => {
          events.push('A:start');
          await new Promise<void>((r) => setTimeout(r, 20));
          events.push('A:end');
        });

        const taskB = serviceB.withLock(async () => {
          events.push('B:start');
          await new Promise<void>((r) => setTimeout(r, 20));
          events.push('B:end');
        });

        await Promise.all([taskA, taskB]);

        // Both completed without error
        expect(events).toHaveLength(4);

        // The events must be non-interleaved: either A fully completes before B starts, or vice-versa
        const aStartIdx = events.indexOf('A:start');
        const aEndIdx = events.indexOf('A:end');
        const bStartIdx = events.indexOf('B:start');
        const bEndIdx = events.indexOf('B:end');

        const aBeforeB = aEndIdx < bStartIdx;
        const bBeforeA = bEndIdx < aStartIdx;

        expect(aBeforeB || bBeforeA).toBe(true);
      } finally {
        await serviceA.dispose();
        await serviceB.dispose();
        // Prevent afterEach from double-disposing the default `service`
        service = undefined as unknown as FileLockService;
      }
    });
  });
});
